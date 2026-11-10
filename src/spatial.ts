/**
 * Spatial filter pushdown: `geometry && <constant>` → an ArcGIS spatial query.
 *
 * DuckDB sends `duckdb.spatial/intersects_extent@1` (`&&`, a bounding-box
 * test) when a query filters on it, and VGI derives it from exact predicates
 * against a constant (ST_Intersects, ST_Within, ST_Contains, ...). Either way
 * the worker may return MORE rows than match, never fewer: the SDK re-applies
 * every pushed predicate to each batch (`autoApplyFilters`) and DuckDB keeps
 * the exact predicate.
 *
 * The ArcGIS request uses `spatialRel=esriSpatialRelEnvelopeIntersects`: true
 * when the feature's envelope intersects the query geometry's envelope, the
 * same test as `&&`. Two differences could make the server drop a row that
 * `&&` keeps, so the box is widened first:
 *
 * - Rounding. The worker returns coordinates rounded to `precision` decimals,
 *   and DuckDB tests those; the server tests the stored geometry. A feature just
 *   outside the box can round to just inside. Pad by 2·10^-precision.
 * - Projection. The server projects the WGS84 query geometry into the layer's
 *   spatial reference and compares envelopes there. Sending a densified ring,
 *   not a bare envelope, keeps the projected envelope close to the true one,
 *   and a relative margin covers what is left.
 *
 * A box that reaches past ±180°/±90° after padding is not sent: the world-edge
 * behaviour of reprojection varies by server, and such a box selects little.
 */

import type { PushdownFilters } from "@query-farm/vgi";
import { wkbExtent } from "./wkb.ts";

type Expr = PushdownFilters["filters"][number];

export interface Box {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

const INTERSECTS_EXTENT = { namespace: "duckdb.spatial", name: "intersects_extent", version: 1 } as const;

/** Points per side of the densified query ring. */
const DENSIFY = 8;
/** Relative margin for reprojection: a fraction of the box's larger side. */
const PROJECTION_MARGIN = 0.005;

function isIntersectsExtent(e: Expr): e is Extract<Expr, { node: "call" }> {
  if (e.node !== "call" || typeof e.function === "string") return false;
  const f = e.function;
  return (
    f.namespace === INTERSECTS_EXTENT.namespace &&
    f.name === INTERSECTS_EXTENT.name &&
    f.version === INTERSECTS_EXTENT.version
  );
}

function literalBytes(e: Expr): Uint8Array | undefined {
  if (e.node === "literal") return e.value instanceof Uint8Array ? e.value : undefined;
  if (e.node === "cast") return literalBytes(e.expression);
  return undefined;
}

/** The constant's box when `e` is `<column> && <constant>`, in either order. */
function boxOf(e: Expr, column: string): Box | undefined {
  if (!isIntersectsExtent(e) || e.arguments.length !== 2) return undefined;
  const [a, b] = e.arguments as [Expr, Expr];
  const isColumn = (x: Expr) => x.node === "column_ref" && x.columnName === column;
  const constant = isColumn(a) ? literalBytes(b) : isColumn(b) ? literalBytes(a) : undefined;
  if (!constant) return undefined;
  let extent: ReturnType<typeof wkbExtent>;
  try {
    extent = wkbExtent(constant);
  } catch {
    return undefined;
  }
  const finite = [extent.xmin, extent.ymin, extent.xmax, extent.ymax].every(Number.isFinite);
  // An empty constant matches nothing (DuckDB applies that itself); a NaN or
  // infinite one has no usable box.
  if (extent.vertices === 0 || !finite) return undefined;
  return { xmin: extent.xmin, ymin: extent.ymin, xmax: extent.xmax, ymax: extent.ymax };
}

/**
 * The box to send for the pushed filters on `column`, or undefined. Filters
 * are ANDed, so any one of them is a sound superset; with several, the
 * smallest is sent. Their intersection would not be sound: a feature can meet
 * two boxes without meeting their overlap.
 */
export function spatialFilterBox(filters: readonly Expr[], column: string): Box | undefined {
  const boxes: Box[] = [];
  const visit = (e: Expr) => {
    if (e.node === "and") e.children.forEach(visit);
    else {
      const box = boxOf(e, column);
      if (box) boxes.push(box);
    }
  };
  filters.forEach(visit);
  const area = (b: Box) => (b.xmax - b.xmin) * (b.ymax - b.ymin);
  return boxes.sort((p, q) => area(p) - area(q))[0];
}

/** `box` widened for coordinate rounding and reprojection (see the module comment). */
export function padBox(box: Box, precision: number): Box | undefined {
  const side = Math.max(box.xmax - box.xmin, box.ymax - box.ymin);
  const pad = 2 * 10 ** -precision + 1e-9 + PROJECTION_MARGIN * side;
  const out = { xmin: box.xmin - pad, ymin: box.ymin - pad, xmax: box.xmax + pad, ymax: box.ymax + pad };
  if (out.xmin < -180 || out.xmax > 180 || out.ymin < -90 || out.ymax > 90) return undefined;
  return out;
}

/** The ArcGIS `/query` parameters for a WGS84 box: a densified ring, envelope semantics. */
export function spatialQueryParams(box: Box): Record<string, string> {
  const ring: [number, number][] = [];
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    for (let i = 0; i < DENSIFY; i++) {
      const t = i / DENSIFY;
      ring.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
    }
  };
  const { xmin, ymin, xmax, ymax } = box;
  // Clockwise, as ArcGIS expects for an outer ring.
  edge(xmin, ymin, xmin, ymax);
  edge(xmin, ymax, xmax, ymax);
  edge(xmax, ymax, xmax, ymin);
  edge(xmax, ymin, xmin, ymin);
  ring.push([xmin, ymin]);
  const round = (v: number) => Number(v.toPrecision(15));
  return {
    geometry: JSON.stringify({ rings: [ring.map(([x, y]) => [round(x), round(y)])], spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPolygon",
    inSR: "4326",
    spatialRel: "esriSpatialRelEnvelopeIntersects",
  };
}
