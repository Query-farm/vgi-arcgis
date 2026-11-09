/**
 * SQL names for ArcGIS services and layers.
 *
 * Names must be readable, valid unquoted DuckDB identifiers, and stable: the
 * same service structure always yields the same names, whatever order the
 * server lists things in, so a view's name does not change when a sibling is
 * added. Rules:
 *
 * 1. `sqlName`: lowercase words joined by `_`. A name with no spaces is split
 *    at CamelCase boundaries, keeping acronyms whole (`USGSNAIPImageryIndex` →
 *    `usgs_naip_imagery_index`). A name that would start with a digit gets a
 *    leading `_` (`3DEPElevationIndex` → `_3dep_elevation_index`).
 * 2. `assignNames`: when names collide, EVERY member of the collision is
 *    qualified, never just the later ones: first by its enclosing group layers,
 *    innermost first (`query_1_meter` vs `dem_product_index_1_meter`), and only
 *    when those are exhausted by its id.
 */

/** A readable, unquoted-safe SQL identifier for an ArcGIS name. */
export function sqlName(name: string): string {
  let s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  if (!/\s/.test(s.trim())) {
    // Identifier-like names (service names, mostly): split CamelCase.
    s = s.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
  }
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) return "unnamed";
  return /^[0-9]/.test(base) ? `_${base}` : base;
}

export interface NameRequest {
  /** The object's own name. */
  name: string;
  /** Enclosing group names, outermost first. */
  groups?: string[];
  /** Unique within the request list; the last-resort qualifier. */
  id: number | string;
}

/**
 * Unique SQL names for `items`, avoiding `taken`. Unique names stay short; a
 * collision qualifies all of its members (see the module comment).
 */
export function assignNames(items: NameRequest[], taken: Iterable<string> = []): string[] {
  const reserved = new Set(taken);
  // level k: qualify with the k innermost groups; past the groups, append the id.
  const level = items.map(() => 0);
  const nameAt = (i: number): string => {
    const item = items[i] as NameRequest;
    const groups = item.groups ?? [];
    const k = level[i] as number;
    const qualifiers = groups.slice(Math.max(0, groups.length - k)).map(sqlName);
    const parts = [...qualifiers, sqlName(item.name)].map((p) => p.replace(/^_/, ""));
    let out = sqlName(parts.join("_"));
    if (k > groups.length) out = `${out}_${sqlName(String(item.id)).replace(/^_/, "")}`;
    return out;
  };
  for (;;) {
    const names = items.map((_, i) => nameAt(i));
    const counts = new Map<string, number>();
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    let changed = false;
    names.forEach((n, i) => {
      if ((counts.get(n) ?? 0) > 1 || reserved.has(n)) {
        const groups = items[i]?.groups ?? [];
        if ((level[i] as number) <= groups.length) {
          level[i] = (level[i] as number) + 1;
          changed = true;
        }
      }
    });
    if (!changed) return dedupeLast(names, reserved);
  }
}

/** Ids should make names unique; if they do not (duplicate ids), number the rest. */
function dedupeLast(names: string[], reserved: Set<string>): string[] {
  const used = new Set(reserved);
  return names.map((n) => {
    let candidate = n;
    for (let k = 2; used.has(candidate); k++) candidate = `${n}_${k}`;
    used.add(candidate);
    return candidate;
  });
}
