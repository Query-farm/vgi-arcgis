/**
 * Turn an ATTACH `url` into schemas and views.
 *
 * - A services directory becomes one schema per FeatureServer/MapServer
 *   service (a FeatureServer wins over its MapServer twin), named
 *   `<folder>_<service>` in lowercase.
 * - A service becomes one view per feature layer and table, in `main`.
 * - A layer becomes one view in `main`.
 *
 * Every view is `SELECT ... FROM main.arcgis_query('<layer url>')`, so it
 * inherits filter pushdown and paging; layers with geometry swap
 * `geometry_geojson` for a GEOMETRY column built by DuckDB spatial.
 */

import { classifyUrl, type DirectoryMeta, GEOMETRY_GEOJSON, type LayerMeta, type ServiceMeta } from "./esri.ts";
import { getMetadata, isAuthError } from "./http.ts";
import { log } from "./log.ts";
import { assignNames, sqlName } from "./naming.ts";

export interface DiscoveredSchema {
  name: string;
  comment: string;
  serviceUrl: string;
}

export interface DiscoveredView {
  name: string;
  comment: string;
  definition: string;
  layerUrl: string;
  hasGeometry: boolean;
  /** The layer's id within its service. */
  layerId: number;
  /** Group layers enclosing it, outermost first, then its own name. */
  layerPath: string[];
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The SQL behind a view over one layer. */
export function viewDefinition(layerUrl: string, hasGeometry: boolean): string {
  const source = `main.arcgis_query(${sqlString(layerUrl)})`;
  return hasGeometry
    ? `SELECT * EXCLUDE (${GEOMETRY_GEOJSON}), ST_GeomFromGeoJSON(${GEOMETRY_GEOJSON}) AS geometry FROM ${source}`
    : `SELECT * FROM ${source}`;
}

const FEATURE_SERVICE_TYPES = ["FeatureServer", "MapServer"];

/** Schemas for a services directory (the root or one folder). */
export async function directorySchemas(dirUrl: string): Promise<DiscoveredSchema[]> {
  const root = dirUrl.replace(/(\/rest\/services)(\/[^/]+)?$/i, "$1");
  const top = (await getMetadata(`${dirUrl}?f=json`)) as DirectoryMeta;
  const listings = [top];
  if (dirUrl === root) {
    const folders = await Promise.all(
      (top.folders ?? []).map((f) => getMetadata(`${root}/${encodeURIComponent(f)}?f=json`) as Promise<DirectoryMeta>),
    );
    listings.push(...folders);
  }
  const byName = new Map<string, { name: string; type: string }>();
  for (const svc of listings.flatMap((l) => l.services ?? [])) {
    if (!FEATURE_SERVICE_TYPES.includes(svc.type)) continue;
    const prior = byName.get(svc.name);
    if (!prior || (prior.type === "MapServer" && svc.type === "FeatureServer")) byName.set(svc.name, svc);
  }
  const services = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  // Schema names keep the folder (`Folder/Service` → `folder_service`).
  const names = assignNames(
    services.map((s) => ({ name: s.name.replace(/\//g, " ").replace(/\s+/g, "_"), id: s.type })),
    ["main"],
  );
  return services.map((svc, i) => ({
    name: names[i] as string,
    comment: `ArcGIS ${svc.type} ${svc.name}`,
    serviceUrl: `${root}/${svc.name.split("/").map(encodeURIComponent).join("/")}/${svc.type}`,
  }));
}

/**
 * Views for every feature layer and table of a service. A service that needs a
 * token has none: one subscriber-only service must not break listing (or
 * DuckDB's "did you mean" search over) every other service in a directory.
 */
export async function serviceViews(serviceUrl: string): Promise<DiscoveredView[]> {
  let meta: ServiceMeta;
  try {
    meta = (await getMetadata(`${serviceUrl}?f=json`)) as ServiceMeta;
  } catch (err) {
    if (!isAuthError(err)) throw err;
    log.warn(`skipping ${serviceUrl}: ${(err as Error).message} (token-secured services are not supported)`);
    return [];
  }
  const description = (meta.serviceDescription || meta.description || "").replace(/<[^>]+>/g, "").trim();
  // Group layers are not queryable, but they name what they contain: services
  // often repeat a layer under several groups ("DEM Product Index" > "1 meter"
  // and "Query" > "1 Meter"), and the group tells those apart.
  const byId = new Map((meta.layers ?? []).map((l) => [l.id, l]));
  const groupsOf = (parentId: number | undefined): string[] => {
    const out: string[] = [];
    const seen = new Set<number>();
    for (let p = parentId; p !== undefined && p >= 0 && !seen.has(p); p = byId.get(p)?.parentLayerId) {
      seen.add(p);
      const parent = byId.get(p);
      if (!parent) break;
      out.unshift(parent.name);
    }
    return out;
  };
  const entries: {
    id: number;
    name: string;
    groups: string[];
    geometryType: string | null | undefined;
    isTable: boolean;
  }[] = [
    ...(meta.layers ?? [])
      .filter((l) => !l.type || /feature layer/i.test(l.type))
      .map((l) => ({
        id: l.id,
        name: l.name,
        groups: groupsOf(l.parentLayerId),
        geometryType: l.geometryType,
        isTable: false,
      })),
    ...(meta.tables ?? []).map((t) => ({ id: t.id, name: t.name, groups: [], geometryType: null, isTable: true })),
  ];
  // MapServer listings may omit geometryType; read the layer's own metadata then.
  await Promise.all(
    entries
      .filter((e) => !e.isTable && e.geometryType === undefined)
      .map(async (e) => {
        const layer = (await getMetadata(`${serviceUrl}/${e.id}?f=json`)) as LayerMeta;
        e.geometryType = layer.geometryType ?? null;
      }),
  );
  const names = assignNames(entries.map((e) => ({ name: e.name, groups: e.groups, id: e.id })));
  return entries.map((e, i) => {
    const layerUrl = `${serviceUrl}/${e.id}`;
    const hasGeometry = Boolean(e.geometryType);
    const kind = e.isTable ? "table" : `${(e.geometryType ?? "").replace(/^esriGeometry/, "").toLowerCase()} layer`;
    return {
      name: names[i] as string,
      comment: `${e.name} (ArcGIS ${kind} ${layerUrl})${description ? `. ${description}` : ""}`,
      definition: viewDefinition(layerUrl, hasGeometry),
      layerUrl,
      hasGeometry,
      layerId: e.id,
      layerPath: [...e.groups, e.name],
    };
  });
}

/** The single view for a layer URL. */
export async function layerViews(layerUrl: string): Promise<DiscoveredView[]> {
  const meta = (await getMetadata(`${layerUrl}?f=json`)) as LayerMeta;
  const hasGeometry = Boolean(meta.geometryType);
  const name = meta.name ?? "layer";
  return [
    {
      name: sqlName(name),
      comment: `${name} (ArcGIS layer ${layerUrl})`,
      definition: viewDefinition(layerUrl, hasGeometry),
      layerUrl,
      hasGeometry,
      layerId: Number(layerUrl.match(/\/(\d+)$/)?.[1] ?? 0),
      layerPath: [name],
    },
  ];
}

/** Views that belong in `main` for an ATTACH url (service and layer URLs). */
export async function mainViews(url: string): Promise<DiscoveredView[]> {
  const target = classifyUrl(url);
  if (target.kind === "service") return serviceViews(target.url);
  if (target.kind === "layer") return layerViews(target.url);
  return [];
}
