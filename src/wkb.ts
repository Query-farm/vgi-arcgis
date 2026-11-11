/**
 * Well-known binary (WKB) for the `geometry` column and for spatial filters.
 *
 * - `geojsonToWkb`: GeoJSON from ArcGIS (or reshaped Esri JSON) as little-endian
 *   ISO WKB, which the worker emits as a `geoarrow.wkb` column that DuckDB reads
 *   as GEOMETRY. 2D only: queries never ask ArcGIS for Z or M.
 * - `wkbExtent`: the XY box of a WKB value, as DuckDB 2.0 core computes it for
 *   `&&` (vgi-filter-encoding-v2 spec section 5.11.1). Used on the constants of
 *   pushed `geometry && <constant>` filters.
 */

const POINT = 1;
const LINESTRING = 2;
const POLYGON = 3;
const MULTIPOINT = 4;
const MULTILINESTRING = 5;
const MULTIPOLYGON = 6;
const COLLECTION = 7;

class Writer {
  private buf = new ArrayBuffer(256);
  private view = new DataView(this.buf);
  private len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.len + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.len));
    this.buf = next;
    this.view = new DataView(next);
  }

  header(type: number): void {
    this.ensure(5);
    this.view.setUint8(this.len, 1);
    this.view.setUint32(this.len + 1, type, true);
    this.len += 5;
  }

  uint32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.len, v, true);
    this.len += 4;
  }

  xy(x: number, y: number): void {
    this.ensure(16);
    this.view.setFloat64(this.len, x, true);
    this.view.setFloat64(this.len + 8, y, true);
    this.len += 16;
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.buf.slice(0, this.len));
  }
}

function coord(p: unknown): [number, number] {
  if (!Array.isArray(p) || p.length < 2) throw new Error("GeoJSON position needs at least two numbers");
  const x = Number(p[0]);
  const y = Number(p[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("GeoJSON position is not finite");
  return [x, y];
}

function list(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error("GeoJSON coordinates must be arrays");
  return v;
}

function points(w: Writer, ps: unknown[]): void {
  w.uint32(ps.length);
  for (const p of ps) w.xy(...coord(p));
}

function polygon(w: Writer, rings: unknown[]): void {
  w.uint32(rings.length);
  for (const r of rings) points(w, list(r));
}

function write(w: Writer, g: Record<string, unknown>, depth: number): void {
  if (depth > 32) throw new Error("GeoJSON geometry collections nest too deeply");
  const c = g.coordinates;
  switch (g.type) {
    case "Point": {
      w.header(POINT);
      const p = list(c);
      if (p.length === 0) w.xy(Number.NaN, Number.NaN);
      else w.xy(...coord(p));
      return;
    }
    case "LineString":
      w.header(LINESTRING);
      points(w, list(c));
      return;
    case "Polygon":
      w.header(POLYGON);
      polygon(w, list(c));
      return;
    case "MultiPoint": {
      const ps = list(c);
      w.header(MULTIPOINT);
      w.uint32(ps.length);
      for (const p of ps) write(w, { type: "Point", coordinates: p }, depth + 1);
      return;
    }
    case "MultiLineString": {
      const ls = list(c);
      w.header(MULTILINESTRING);
      w.uint32(ls.length);
      for (const l of ls) write(w, { type: "LineString", coordinates: l }, depth + 1);
      return;
    }
    case "MultiPolygon": {
      const polys = list(c);
      w.header(MULTIPOLYGON);
      w.uint32(polys.length);
      for (const p of polys) write(w, { type: "Polygon", coordinates: p }, depth + 1);
      return;
    }
    case "GeometryCollection": {
      const gs = list(g.geometries);
      w.header(COLLECTION);
      w.uint32(gs.length);
      for (const child of gs) write(w, child as Record<string, unknown>, depth + 1);
      return;
    }
    default:
      throw new Error(`unsupported GeoJSON geometry type '${String(g.type)}'`);
  }
}

/** A GeoJSON geometry object as little-endian ISO WKB (2D). */
export function geojsonToWkb(geometry: unknown): Uint8Array {
  if (!geometry || typeof geometry !== "object") throw new Error("GeoJSON geometry must be an object");
  const w = new Writer();
  write(w, geometry as Record<string, unknown>, 0);
  return w.bytes();
}

/** An XY box; `vertices` 0 means the geometry is empty and intersects nothing. */
export interface Extent {
  vertices: number;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

const EWKB_Z = 0x80000000;
const EWKB_M = 0x40000000;
const EWKB_SRID = 0x20000000;

/**
 * The XY box of a WKB geometry (ISO or EWKB, either byte order), with DuckDB 2.0
 * core's rules: a POINT whose coordinates are all NaN has no vertex; any other
 * NaN makes that axis unbounded; infinities are ordinary values.
 *
 * @throws Error on malformed WKB.
 */
export function wkbExtent(wkb: Uint8Array): Extent {
  const view = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
  const e: Extent = { vertices: 0, xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity };
  let pos = 0;
  const need = (n: number) => {
    if (pos + n > wkb.byteLength) throw new Error("truncated WKB");
  };
  const add = (x: number, y: number) => {
    e.vertices++;
    if (Number.isNaN(x)) [e.xmin, e.xmax] = [-Infinity, Infinity];
    else [e.xmin, e.xmax] = [Math.min(e.xmin, x), Math.max(e.xmax, x)];
    if (Number.isNaN(y)) [e.ymin, e.ymax] = [-Infinity, Infinity];
    else [e.ymin, e.ymax] = [Math.min(e.ymin, y), Math.max(e.ymax, y)];
  };
  const read = (depth: number): void => {
    if (depth > 128) throw new Error("WKB nests too deeply");
    need(5);
    const order = wkb[pos];
    if (order !== 0 && order !== 1) throw new Error(`invalid WKB byte order ${order}`);
    const le = order === 1;
    const raw = view.getUint32(pos + 1, le);
    pos += 5;
    const flags = raw & (EWKB_Z | EWKB_M | EWKB_SRID);
    const code = raw & 0x0fffffff;
    const base = code % 1000;
    const iso = Math.floor(code / 1000);
    if (code > 0xffff || base < 1 || base > 7 || iso > 3) throw new Error(`unsupported WKB type ${raw}`);
    if (iso && flags & (EWKB_Z | EWKB_M)) throw new Error(`WKB type ${raw} mixes ISO and EWKB dimensions`);
    if (flags & EWKB_SRID) {
      need(4);
      pos += 4;
    }
    const dims = 2 + (flags & EWKB_Z || iso === 1 || iso === 3 ? 1 : 0) + (flags & EWKB_M || iso >= 2 ? 1 : 0);
    const count = (): number => {
      need(4);
      const n = view.getUint32(pos, le);
      pos += 4;
      return n;
    };
    const vertices = (n: number, isPoint: boolean) => {
      need(n * dims * 8);
      for (let i = 0; i < n; i++) {
        const c: number[] = [];
        for (let d = 0; d < dims; d++) c.push(view.getFloat64(pos + d * 8, le));
        pos += dims * 8;
        if (isPoint && c.every(Number.isNaN)) continue;
        add(c[0] as number, c[1] as number);
      }
    };
    if (base === POINT) vertices(1, true);
    else if (base === LINESTRING) vertices(count(), false);
    else if (base === POLYGON) {
      const rings = count();
      for (let r = 0; r < rings; r++) vertices(count(), false);
    } else {
      const parts = count();
      if (parts > (wkb.byteLength - pos) / 5) throw new Error("truncated WKB");
      for (let p = 0; p < parts; p++) read(depth + 1);
    }
  };
  read(0);
  if (pos !== wkb.byteLength) throw new Error("trailing bytes after WKB geometry");
  return e;
}
