/**
 * ArcGIS REST vocabulary: URL kinds, metadata shapes, field types, and the
 * Esri JSON -> GeoJSON reshaping used for servers that cannot emit GeoJSON.
 */

import { float32, float64, int16, int32, int64, TimeUnit, timestamp, utf8, type VgiDataType } from "@query-farm/vgi";

/** What an ATTACH or function URL points at. */
export type UrlKind =
  | { kind: "layer"; url: string; serviceUrl: string; layerId: number }
  | { kind: "service"; url: string }
  | { kind: "directory"; url: string };

/** Strip the query string, fragment and trailing slashes. */
export function normalizeUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/+$/, "");
}

/**
 * Classify an ArcGIS REST URL: a layer (`.../FeatureServer/0`), a service
 * (`.../MapServer`) or a services directory (`.../rest/services[/folder]`).
 *
 * @throws Error for anything else, including ArcGIS Hub site URLs.
 */
export function classifyUrl(raw: string): UrlKind {
  let url: string;
  try {
    url = normalizeUrl(raw);
  } catch {
    throw new Error(`not a valid URL: '${raw}'`);
  }
  if (!/^https?:\/\//i.test(url)) throw new Error(`URL must start with http:// or https://: '${raw}'`);
  const path = new URL(url).pathname;
  const layer = path.match(/\/(FeatureServer|MapServer)\/(\d+)$/i);
  if (layer) {
    return { kind: "layer", url, serviceUrl: url.replace(/\/\d+$/, ""), layerId: Number(layer[2]) };
  }
  if (/\/(FeatureServer|MapServer)$/i.test(path)) return { kind: "service", url };
  if (/\/rest\/services(\/[^/]+)?$/i.test(path)) return { kind: "directory", url };
  throw new Error(
    `unsupported ArcGIS URL '${raw}': expected a layer (.../FeatureServer/0), a service ` +
      "(.../FeatureServer or .../MapServer) or a services directory (.../arcgis/rest/services)",
  );
}

export interface EsriField {
  name: string;
  type: string;
  alias?: string;
}

/** The parts of a layer's `?f=json` document the worker reads. */
export interface LayerMeta {
  id?: number;
  name?: string;
  type?: string;
  description?: string;
  geometryType?: string | null;
  objectIdField?: string;
  fields?: EsriField[] | null;
  maxRecordCount?: number;
  supportedQueryFormats?: string;
  advancedQueryCapabilities?: { supportsOrderBy?: boolean; supportsPagination?: boolean };
  supportsAdvancedQueries?: boolean;
}

/** The parts of a service's `?f=json` document the worker reads. */
export interface ServiceMeta {
  serviceDescription?: string;
  description?: string;
  layers?: { id: number; name: string; type?: string; geometryType?: string | null; parentLayerId?: number }[];
  tables?: { id: number; name: string; type?: string }[];
}

/** The parts of a services directory document the worker reads. */
export interface DirectoryMeta {
  folders?: string[];
  services?: { name: string; type: string }[];
}

/** Name of the GEOMETRY column (WKB, WGS84) of layers with geometry. */
export const GEOMETRY = "geometry";

/** Arrow type for an Esri field type, or undefined for types the worker skips (blob, raster, xml, geometry). */
export function arrowType(esriType: string): VgiDataType | undefined {
  switch (esriType) {
    case "esriFieldTypeOID":
    case "esriFieldTypeInteger":
      // The SDK exports `int32` as a type instance, unlike the other factories.
      return int32;
    case "esriFieldTypeBigInteger":
      return int64();
    case "esriFieldTypeSmallInteger":
      return int16();
    case "esriFieldTypeSingle":
      return float32; // an instance, not a factory
    case "esriFieldTypeDouble":
      return float64();
    case "esriFieldTypeString":
    case "esriFieldTypeGUID":
    case "esriFieldTypeGlobalID":
    case "esriFieldTypeDateOnly":
    case "esriFieldTypeTimeOnly":
    case "esriFieldTypeTimestampOffset":
      return utf8();
    case "esriFieldTypeDate":
      return timestamp(TimeUnit.MILLISECOND);
    default:
      return undefined;
  }
}

/** The attribute fields a layer exposes as columns, in server order. */
export function attributeFields(meta: LayerMeta): EsriField[] {
  const reserved = new Set(meta.geometryType ? [GEOMETRY] : []);
  return (meta.fields ?? []).filter((f) => arrowType(f.type) !== undefined && !reserved.has(f.name.toLowerCase()));
}

/** Does the layer answer `f=geojson` queries? */
export function supportsGeoJson(meta: LayerMeta): boolean {
  return (meta.supportedQueryFormats ?? "").split(",").some((f) => f.trim().toLowerCase() === "geojson");
}

type Position = number[];
type Ring = Position[];

/** Twice the signed area; negative for clockwise rings (y up). */
function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const [x1 = 0, y1 = 0] = ring[i] ?? [];
    const [x2 = 0, y2 = 0] = ring[i + 1] ?? [];
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

function pointInRing(point: Position, ring: Ring): boolean {
  const [x = 0, y = 0] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi = 0, yi = 0] = ring[i] ?? [];
    const [xj = 0, yj = 0] = ring[j] ?? [];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Esri polygon rings -> GeoJSON Polygon/MultiPolygon coordinates.
 * Esri outer rings are clockwise and holes counter-clockwise; each hole is
 * assigned to the outer ring that contains its first vertex.
 */
function ringsToPolygons(rings: Ring[]): Ring[][] {
  const outers: Ring[][] = [];
  const holes: Ring[] = [];
  for (const ring of rings) {
    if (ring.length < 4) continue;
    if (signedArea(ring) < 0) outers.push([ring]);
    else holes.push(ring);
  }
  if (outers.length === 0) return holes.map((h) => [h]); // all counter-clockwise: treat each as a polygon
  for (const hole of holes) {
    const first = hole[0] ?? [];
    const owner = outers.find((poly) => poly[0] && pointInRing(first, poly[0])) ?? outers[outers.length - 1];
    owner?.push(hole);
  }
  return outers;
}

/** Reshape one Esri JSON geometry as a GeoJSON geometry object, or null. */
export function esriToGeoJson(geometry: unknown): Record<string, unknown> | null {
  if (!geometry || typeof geometry !== "object") return null;
  const g = geometry as { x?: number; y?: number; z?: number; points?: Position[]; paths?: Ring[]; rings?: Ring[] };
  if (typeof g.x === "number" && typeof g.y === "number") {
    if (Number.isNaN(g.x) || Number.isNaN(g.y)) return null;
    return { type: "Point", coordinates: typeof g.z === "number" ? [g.x, g.y, g.z] : [g.x, g.y] };
  }
  if (Array.isArray(g.points)) {
    return g.points.length ? { type: "MultiPoint", coordinates: g.points } : null;
  }
  if (Array.isArray(g.paths)) {
    if (g.paths.length === 0) return null;
    return g.paths.length === 1
      ? { type: "LineString", coordinates: g.paths[0] }
      : { type: "MultiLineString", coordinates: g.paths };
  }
  if (Array.isArray(g.rings)) {
    const polygons = ringsToPolygons(g.rings);
    if (polygons.length === 0) return null;
    return polygons.length === 1
      ? { type: "Polygon", coordinates: polygons[0] }
      : { type: "MultiPolygon", coordinates: polygons };
  }
  return null;
}
