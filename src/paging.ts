/** ArcGIS paging, including sparse spatial pages and legacy object-ID batching. */
import type { LayerMeta } from "./esri.ts";
import { ArcgisError, getJson, type RequestAuth } from "./http.ts";

export interface Feature {
  id?: number | string;
  properties?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  geometry?: unknown;
}

interface FeatureResponse {
  features?: Feature[];
  exceededTransferLimit?: boolean;
  properties?: { exceededTransferLimit?: boolean };
}

export interface ScanState {
  lastOid: number;
  started: boolean;
  offset: number;
  pages: number;
  done: boolean;
  idScan: string;
}

/** MapServer metadata often omits objectIdField but identifies it in fields. */
export function objectIdField(meta: LayerMeta): string | undefined {
  const explicit = meta.fields?.find((f) => f.name === meta.objectIdField);
  if (explicit && !["esriFieldTypeOID", "esriFieldTypeInteger", "esriFieldTypeBigInteger"].includes(explicit.type)) {
    return meta.fields?.find((f) => f.type === "esriFieldTypeOID")?.name;
  }
  return meta.objectIdField ?? meta.fields?.find((f) => f.type === "esriFieldTypeOID")?.name;
}

export function pagingMode(meta: LayerMeta): "keyset" | "offset" | "single" {
  if (objectIdField(meta) && meta.advancedQueryCapabilities?.supportsOrderBy) return "keyset";
  return meta.advancedQueryCapabilities?.supportsPagination ? "offset" : "single";
}

const exceeded = (body: FeatureResponse) =>
  Boolean(body.exceededTransferLimit ?? body.properties?.exceededTransferLimit);
const attrs = (feature: Feature) => feature.attributes ?? feature.properties ?? {};
const safeId = (value: unknown): number => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isSafeInteger(n)) throw new ArcgisError("ArcGIS returned a missing or unsafe integer object ID");
  return n;
};

// This is only an optimization. The portable cursor is lastOid: another HTTP
// worker (or an evicted entry) re-enumerates IDs after it. Never serialize a
// national layer's ID array into the per-batch state or share it across identities.
const idCache = new Map<string, { key: string; ids: number[]; at: number }>();
const CACHE_IDS = 1_000_000;
const CACHE_SCANS = 4;

async function idsPage(
  url: string,
  q: URLSearchParams,
  meta: LayerMeta,
  state: ScanState,
  auth?: RequestAuth | null,
): Promise<Feature[]> {
  const oid = objectIdField(meta);
  if (!oid || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(oid)) {
    throw new ArcgisError(`${url}: truncated result cannot be continued without an integer object-ID field`);
  }
  const query = new URLSearchParams(q);
  for (const name of ["orderByFields", "resultOffset", "resultRecordCount"]) query.delete(name);
  if (state.started) query.set("where", `(${query.get("where") || "1=1"}) AND ${oid} > ${state.lastOid}`);
  const cacheQuery = new URLSearchParams(q);
  cacheQuery.delete("resultRecordCount");
  const key = `${auth?.id ?? "anonymous"} ${url} ${cacheQuery}`;
  const hit = idCache.get(state.idScan);
  let ids: number[];
  if (hit && hit.key === key && Date.now() - hit.at < 300_000) {
    ids = hit.ids;
  } else {
    const enumeration = new URLSearchParams(query);
    enumeration.set("f", "json");
    enumeration.set("returnIdsOnly", "true");
    enumeration.set("returnGeometry", "false");
    const body = (await getJson(`${url}/query?${enumeration}`, auth)) as {
      objectIds?: unknown[] | null;
      exceededTransferLimit?: boolean;
    };
    if (!(Array.isArray(body.objectIds) || body.objectIds === null) || body.exceededTransferLimit) {
      throw new ArcgisError(`${url}: truncated result; server did not return a complete returnIdsOnly response`);
    }
    ids = [...new Set((body.objectIds ?? []).map(safeId))].sort((a, b) => a - b);
    if (ids.length <= CACHE_IDS) {
      if (idCache.size >= CACHE_SCANS) idCache.delete(idCache.keys().next().value as string);
      idCache.set(state.idScan, { key, ids, at: Date.now() });
    }
  }
  // Binary search avoids repeatedly walking millions of already emitted IDs.
  let lo = 0;
  let hi = ids.length;
  if (state.started)
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((ids[mid] as number) <= state.lastOid) lo = mid + 1;
      else hi = mid;
    }
  let selected = ids.slice(lo, lo + Math.min(meta.maxRecordCount ?? 1000, 200));
  if (!selected.length) {
    state.done = true;
    idCache.delete(state.idScan);
    return [];
  }
  let body: FeatureResponse;
  for (;;) {
    query.set("objectIds", selected.join(","));
    body = (await getJson(`${url}/query?${query}`, auth)) as FeatureResponse;
    if (!Array.isArray(body.features)) throw new ArcgisError(`${url}: missing features in query response`);
    if (!exceeded(body)) break;
    if (selected.length === 1) throw new ArcgisError(`${url}: server truncated a single object-ID request`);
    selected = selected.slice(0, Math.ceil(selected.length / 2));
  }
  const requested = new Set(selected);
  const seen = new Set<number>();
  for (const feature of body.features as Feature[]) {
    const id = safeId(attrs(feature)[oid] ?? feature.id);
    if (!requested.has(id) || seen.has(id))
      throw new ArcgisError(`${url}: server ignored objectIds or repeated an object ID`);
    seen.add(id);
  }
  state.lastOid = selected[selected.length - 1] as number;
  state.started = true;
  state.done = lo + selected.length === ids.length;
  if (state.done) idCache.delete(state.idScan);
  return body.features as Feature[];
}

export async function readPage(
  url: string,
  base: URLSearchParams,
  meta: LayerMeta,
  state: ScanState,
  auth?: RequestAuth | null,
): Promise<Feature[]> {
  const mode = pagingMode(meta);
  const oid = objectIdField(meta);
  const q = new URLSearchParams(base);
  if (state.idScan) return idsPage(url, base, meta, state, auth);
  if (mode === "keyset") {
    q.set("orderByFields", `${oid} ASC`);
    if (state.started) q.set("where", `(${q.get("where") || "1=1"}) AND ${oid} > ${state.lastOid}`);
  }
  if (mode === "offset") q.set("resultOffset", String(state.offset));
  const body = (await getJson(`${url}/query?${q}`, auth)) as FeatureResponse;
  if (!Array.isArray(body.features)) throw new ArcgisError(`${url}: missing features in query response`);
  const more = exceeded(body);
  if (more && (mode === "single" || (mode === "keyset" && !body.features.length))) {
    state.idScan = crypto.randomUUID();
    return idsPage(url, base, meta, state, auth);
  }
  if (mode === "keyset" && oid) {
    let previous = state.started ? state.lastOid : -Infinity;
    for (const feature of body.features) {
      const id = safeId(attrs(feature)[oid] ?? feature.id);
      if (id <= previous) throw new ArcgisError(`${url}: object-ID paging did not advance in ascending order`);
      previous = id;
    }
    if (body.features.length) {
      state.lastOid = previous;
      state.started = true;
    }
  }
  // Spatial-index filtering may yield fewer (even zero) records than the page
  // window. Advance the requested window, not the returned feature count.
  state.offset += mode === "offset" ? Number(q.get("resultRecordCount")) : body.features.length;
  state.done = !more;
  return body.features;
}
