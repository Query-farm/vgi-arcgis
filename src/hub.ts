/**
 * ArcGIS Hub / Open Data site URLs.
 *
 * REST URLs are classified synchronously by `classifyUrl` (esri.ts). Anything
 * else that is an http(s) URL goes through `resolveUrl`:
 *
 * - A dataset page (`/datasets/<id>`, `/maps/<id>`, `/items/<id>`, with any
 *   `/about`, `/explore`, ... suffix) resolves to the REST layer or service
 *   behind it, and from then on behaves exactly like that REST URL. Ids are
 *   `<itemId>_<layer>` (Hub API), a bare `<itemId>` (portal item) or a slug
 *   `[<orgKey>::]<slug>` (matched against the titles the site's own search
 *   returns, since no public API resolves slugs).
 * - Any other page of a Hub site (its root, `/search`, `/pages/...`) is the
 *   site itself: `hub_site`. Attached, it lists one schema per feature or map
 *   service in the site's catalog, like a services directory.
 *
 * The Hub and portal API roots come from ARCGIS_HUB_API and ARCGIS_PORTAL_API
 * so the tests can point them at the offline mock.
 */

import { type DiscoveredSchema, type DiscoveredView, layerViews, serviceViews } from "./discovery.ts";
import { classifyUrl, normalizeUrl, type UrlKind } from "./esri.ts";
import { getMetadata, isAuthError, METADATA_TTL_MS } from "./http.ts";
import { log } from "./log.ts";
import { assignNames } from "./naming.ts";

const trimSlash = (s: string) => s.replace(/\/+$/, "");

/** Root of the Hub API (`/api/v3/domains`, `/api/v3/datasets`). */
export function hubApi(): string {
  return trimSlash(process.env.ARCGIS_HUB_API || "https://hub.arcgis.com");
}

/** Root of the ArcGIS Online sharing API (items, search, portals). */
export function portalApi(): string {
  return trimSlash(process.env.ARCGIS_PORTAL_API || "https://www.arcgis.com/sharing/rest");
}

/** A Hub site: its normalized origin, item id and title. */
export interface HubSite {
  kind: "hub_site";
  url: string;
  siteId: string;
  title: string;
  orgKey: string;
}

export type ResolvedUrl = UrlKind | HubSite;

/** What a non-REST path names. */
export type HubPath =
  | { kind: "site" }
  | { kind: "item"; itemId: string; layerId?: number }
  | { kind: "slug"; slug: string; orgKey?: string };

const ITEM_ID = /^[0-9a-f]{32}$/i;
const DATASET_ROOTS = new Set(["datasets", "maps", "items"]);

/** Parse the path of a Hub URL. */
export function parseHubPath(pathname: string): HubPath {
  const segments = pathname.split("/").filter(Boolean);
  const root = segments[0]?.toLowerCase();
  const raw = segments[1];
  if (!root || !DATASET_ROOTS.has(root) || !raw) return { kind: "site" };
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    id = raw;
  }
  if (ITEM_ID.test(id)) return { kind: "item", itemId: id.toLowerCase() };
  const layered = id.match(/^([0-9a-f]{32})_(\d+)$/i);
  if (layered) return { kind: "item", itemId: (layered[1] as string).toLowerCase(), layerId: Number(layered[2]) };
  const sep = id.indexOf("::");
  if (sep > 0) return { kind: "slug", orgKey: id.slice(0, sep), slug: id.slice(sep + 2).toLowerCase() };
  return { kind: "slug", slug: id.toLowerCase() };
}

/**
 * The slug Hub derives from an item title. Lowercase, runs of anything other
 * than letters and digits become one `-`, trimmed. `hubSlugify` is the
 * variant in @esri/hub-common, which drops punctuation instead (so
 * "California's" is `californias`, not `california-s`); a slug matches either.
 */
export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function hubSlugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]+/g, "")
    .replace(/--+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Does `slug` name an item titled `title`? Hub appends `-1`, `-2`, ... to duplicate slugs. */
function slugMatch(slug: string, title: string): "exact" | "numbered" | null {
  const forms = new Set([slugify(title), hubSlugify(title)]);
  if (forms.has(slug)) return "exact";
  const base = slug.match(/^(.+)-\d+$/)?.[1];
  return base && forms.has(base) ? "numbered" : null;
}

/** A REST service or layer URL, or undefined for anything else (web apps, files, tiles...). */
function restTarget(url: string | null | undefined): UrlKind | undefined {
  if (!url) return undefined;
  try {
    const target = classifyUrl(url);
    return target.kind === "directory" ? undefined : target;
  } catch {
    return undefined;
  }
}

interface DomainRecord {
  siteId?: string;
  siteTitle?: string;
  orgKey?: string;
}

/** Look up the Hub site served at `origin`. @throws Error when the host is not a Hub site. */
async function hubSite(origin: string, raw: string): Promise<HubSite> {
  const host = new URL(origin).hostname;
  let record: DomainRecord;
  try {
    record = (await getMetadata(`${hubApi()}/api/v3/domains/${encodeURIComponent(host)}`)) as DomainRecord;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 404) {
      throw new Error(
        `unsupported ArcGIS URL '${raw}': it is not an ArcGIS REST URL (expected a layer .../FeatureServer/0, ` +
          `a service .../FeatureServer or .../MapServer, or a services directory .../arcgis/rest/services), ` +
          `and ${host} is not an ArcGIS Hub site`,
      );
    }
    throw new Error(`could not look up ${host} as an ArcGIS Hub site: ${(err as Error).message}`);
  }
  if (!record.siteId) throw new Error(`ArcGIS Hub has no site id for ${host}`);
  return {
    kind: "hub_site",
    url: origin,
    siteId: record.siteId,
    title: record.siteTitle ?? host,
    orgKey: record.orgKey ?? "",
  };
}

interface PortalItem {
  id?: string;
  title?: string;
  type?: string;
  url?: string | null;
  orgId?: string | null;
  owner?: string;
  snippet?: string | null;
}

async function portalItem(itemId: string): Promise<PortalItem> {
  return (await getMetadata(`${portalApi()}/content/items/${itemId}?f=json`)) as PortalItem;
}

/** A REST target for `url` (an item's), with `layerId` appended to a service URL. */
function withLayer(url: string | null | undefined, layerId: number | undefined): UrlKind | undefined {
  const target = restTarget(url);
  if (!target || layerId === undefined || target.kind === "layer") return target;
  return classifyUrl(`${target.url}/${layerId}`);
}

/** `<itemId>[_<layer>]` -> the REST layer or service behind it. */
async function resolveItem(itemId: string, layerId: number | undefined, raw: string): Promise<UrlKind> {
  if (layerId !== undefined) {
    try {
      const body = (await getMetadata(`${hubApi()}/api/v3/datasets/${itemId}_${layerId}`)) as {
        data?: { attributes?: { url?: string | null } };
      };
      const target = withLayer(body.data?.attributes?.url, layerId);
      if (target) return target;
    } catch (err) {
      log.debug(`Hub dataset ${itemId}_${layerId}: ${(err as Error).message}; trying the portal item`);
    }
  }
  let item: PortalItem;
  try {
    item = await portalItem(itemId);
  } catch (err) {
    throw new Error(`could not resolve ArcGIS Hub dataset '${raw}': ${(err as Error).message}`);
  }
  const target = withLayer(item.url, layerId);
  if (!target) {
    throw new Error(
      `ArcGIS Hub dataset '${raw}' (${item.type ?? "item"} '${item.title ?? itemId}') has no FeatureServer or ` +
        "MapServer URL; only feature and map services can be queried",
    );
  }
  return target;
}

interface SearchFeature {
  properties?: { id?: string; title?: string; type?: string; url?: string | null; orgId?: string | null };
}

/** The org urlKey of an item, or undefined when the portal does not say. */
async function itemOrgKey(itemId: string, orgId: string | null | undefined): Promise<string | undefined> {
  try {
    const org = orgId || (await portalItem(itemId)).orgId;
    if (!org) return undefined;
    const portal = (await getMetadata(`${portalApi()}/portals/${encodeURIComponent(org)}?f=json`)) as {
      urlKey?: string;
    };
    return portal.urlKey?.toLowerCase();
  } catch {
    return undefined;
  }
}

/** `[<orgKey>::]<slug>` -> the REST target of the one matching item in the site's search. */
async function resolveSlug(site: HubSite, slug: string, orgKey: string | undefined, raw: string): Promise<UrlKind> {
  const words = slug.replace(/-\d+$/, "").split(/[-_]+/).filter(Boolean).join(" ");
  const q = new URLSearchParams({ q: words, limit: "100" });
  let features: SearchFeature[];
  try {
    const body = (await getMetadata(`${site.url}/api/search/v1/collections/all/items?${q}`)) as {
      features?: SearchFeature[];
    };
    features = body.features ?? [];
  } catch (err) {
    throw new Error(
      `could not search ${site.url} for the Hub dataset '${raw}': ${(err as Error).message}. ` +
        "Use the dataset's REST URL (.../FeatureServer/<n>) or its <itemId>_<n> id instead",
    );
  }
  const titled = features
    .map((f) => ({ ...f.properties, match: slugMatch(slug, f.properties?.title ?? "") }))
    .filter((f) => f.match && f.id);
  const exact = titled.filter((f) => f.match === "exact");
  let candidates = (exact.length ? exact : titled).filter((f) => restTarget(f.url));
  if (candidates.length === 0) {
    if (titled.length) {
      const f = titled[0];
      throw new Error(
        `ArcGIS Hub dataset '${raw}' is a ${f?.type ?? "item"} without a FeatureServer or MapServer URL; ` +
          "only feature and map services can be queried",
      );
    }
    throw new Error(
      `ArcGIS Hub dataset '${raw}' was not found in the search of ${site.url}. ` +
        "Use the dataset's REST URL (.../FeatureServer/<n>) or its <itemId>_<n> id instead",
    );
  }
  const wantOrg = (orgKey ?? site.orgKey).toLowerCase();
  if (candidates.length > 1 && wantOrg) {
    const keys = await Promise.all(candidates.map((c) => itemOrgKey(c.id as string, c.orgId)));
    const inOrg = candidates.filter((_, i) => keys[i] === wantOrg);
    if (inOrg.length) candidates = inOrg;
  }
  if (candidates.length > 1) {
    const list = candidates
      .slice(0, 10)
      .map((c) => `'${c.title}' (${c.id}): ${c.url}`)
      .join("; ");
    throw new Error(
      `ArcGIS Hub dataset '${raw}' is ambiguous: ${candidates.length} items match. ` +
        `Use one of their REST URLs or <itemId>_<n> ids instead: ${list}`,
    );
  }
  return restTarget(candidates[0]?.url) as UrlKind;
}

/**
 * Classify any supported URL: REST URLs synchronously (as `classifyUrl`),
 * Hub dataset pages resolved to their REST layer or service, other Hub pages
 * as the site.
 *
 * @throws Error for invalid URLs and for non-REST URLs that are not on a Hub site.
 */
export async function resolveUrl(raw: string): Promise<ResolvedUrl> {
  try {
    return classifyUrl(raw);
  } catch (err) {
    let u: URL;
    try {
      u = new URL(normalizeUrl(raw));
    } catch {
      throw err;
    }
    // Malformed REST URLs (.../FeatureServer/0/query, ...) keep the REST error.
    if (!/^https?:$/.test(u.protocol) || /\/rest\/services/i.test(u.pathname)) throw err;
    const path = parseHubPath(u.pathname);
    if (path.kind === "item") return resolveItem(path.itemId, path.layerId, raw);
    const site = await hubSite(u.origin, raw);
    if (path.kind === "slug") return resolveSlug(site, path.slug, path.orgKey, raw);
    return site;
  }
}

// ------------------------------------------------------------- site catalog

interface SiteData {
  catalog?: { groups?: string[] | string };
  catalogV2?: {
    scopes?: {
      item?: { filters?: { predicates?: { group?: { any?: string[] | string; all?: string[] | string } }[] }[] };
    };
  };
}

const asList = (v: string[] | string | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** The group ids a site's catalog draws from: `catalogV2` item predicates, else the older `catalog.groups`. */
export function siteGroups(data: SiteData): string[] {
  const v2 = (data.catalogV2?.scopes?.item?.filters ?? []).flatMap((f) =>
    (f.predicates ?? []).flatMap((p) => [...asList(p.group?.any), ...asList(p.group?.all)]),
  );
  const groups = v2.length ? v2 : asList(data.catalog?.groups);
  return [...new Set(groups.filter((g) => typeof g === "string" && g))];
}

export interface HubItem {
  id: string;
  title: string;
  type: string;
  url: string | null;
  snippet?: string | null;
  owner?: string;
  access?: string;
}

const SERVICE_TYPES = '(type:"Feature Service" OR type:"Map Service")';
/** Groups per search request: keeps `q` near 2 KB. */
const GROUPS_PER_QUERY = 40;
const PAGE = 100;
/** The search API stops at start + num = 10,000. */
const SEARCH_LIMIT = 10_000;
const PARALLEL_PAGES = 4;

interface SearchPage {
  total?: number;
  nextStart?: number;
  results?: HubItem[];
}

/** Every Feature Service / Map Service item shared to `groups`. */
export async function searchServiceItems(groups: string[]): Promise<HubItem[]> {
  const byId = new Map<string, HubItem>();
  for (let i = 0; i < groups.length; i += GROUPS_PER_QUERY) {
    const chunk = groups.slice(i, i + GROUPS_PER_QUERY);
    const q = `(${chunk.map((g) => `group:${g}`).join(" OR ")}) AND ${SERVICE_TYPES}`;
    const page = (start: number) =>
      getMetadata(
        `${portalApi()}/search?${new URLSearchParams({ q, num: String(PAGE), start: String(start), sortField: "id", f: "json" })}`,
      ) as Promise<SearchPage>;
    const first = await page(1);
    const pages = [first];
    const total = Math.min(first.total ?? 0, SEARCH_LIMIT);
    if ((first.total ?? 0) > SEARCH_LIMIT) {
      log.warn(`site catalog search matched ${first.total} services; only the first ${SEARCH_LIMIT} are listed`);
    }
    if ((first.nextStart ?? -1) > 0) {
      const step = first.results?.length || PAGE;
      const starts: number[] = [];
      for (let s = 1 + step; s <= total; s += step) starts.push(s);
      for (let k = 0; k < starts.length; k += PARALLEL_PAGES) {
        pages.push(...(await Promise.all(starts.slice(k, k + PARALLEL_PAGES).map(page))));
      }
    }
    for (const item of pages.flatMap((p) => p.results ?? [])) {
      if (item?.id && !byId.has(item.id)) byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

/** Last path segment naming the service: `.../Folder/Name/FeatureServer[/0]` -> `Name`. */
function serviceName(url: string): string {
  return url.match(/\/([^/]+)\/(?:FeatureServer|MapServer)(?:\/\d+)?$/i)?.[1] ?? "";
}

/**
 * One schema per service item: items without a REST service URL are dropped,
 * items with the same URL (or a FeatureServer and its MapServer twin) are
 * kept once, preferring the FeatureServer, then the lowest item id. Names are
 * the item titles; duplicates are qualified by owner, then by item id.
 */
export function itemSchemas(items: HubItem[]): (DiscoveredSchema & { itemId: string })[] {
  const byKey = new Map<string, { item: HubItem; url: string }>();
  const isFeature = (url: string) => /\/FeatureServer(\/|$)/i.test(url);
  for (const item of items) {
    const target = restTarget(item.url);
    if (!target) continue;
    const key = target.url.replace(/\/(FeatureServer|MapServer)(?=\/|$)/i, "/~").toLowerCase();
    const prior = byKey.get(key);
    const better =
      !prior ||
      (isFeature(target.url) && !isFeature(prior.url)) ||
      (isFeature(target.url) === isFeature(prior.url) && item.id < prior.item.id);
    if (better) byKey.set(key, { item, url: target.url });
  }
  const kept = [...byKey.values()].sort((a, b) => (a.item.id < b.item.id ? -1 : 1));
  const names = assignNames(
    kept.map(({ item, url }) => ({
      name: item.title || serviceName(url) || item.id,
      groups: item.owner ? [item.owner] : [],
      id: item.id,
    })),
    ["main"],
  );
  return kept
    .map(({ item, url }, i) => {
      const snippet = (item.snippet ?? "").replace(/<[^>]+>/g, "").trim();
      return {
        name: names[i] as string,
        comment: `${item.title}${snippet ? `. ${snippet}` : ""} (ArcGIS Hub item ${item.id}: ${url})`,
        serviceUrl: url,
        itemId: item.id,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const siteMemo = new Map<string, { at: number; value: Promise<(DiscoveredSchema & { itemId: string })[]> }>();

/** Schemas for a Hub site (memoized like metadata: the listing is expensive for big sites). */
export function hubSiteSchemas(site: HubSite): Promise<(DiscoveredSchema & { itemId: string })[]> {
  const key = `${portalApi()} ${site.siteId}`;
  const hit = siteMemo.get(key);
  if (hit && Date.now() - hit.at < METADATA_TTL_MS) return hit.value;
  const value = (async () => {
    const data = (await getMetadata(`${portalApi()}/content/items/${site.siteId}/data?f=json`)) as SiteData;
    const groups = siteGroups(data);
    if (groups.length === 0) {
      throw new Error(
        `ArcGIS Hub site '${site.title}' (${site.url}) has no catalog groups to list; ` +
          "attach its services by REST URL instead",
      );
    }
    return itemSchemas(await searchServiceItems(groups));
  })();
  siteMemo.set(key, { at: Date.now(), value });
  value.catch(() => siteMemo.delete(key));
  return value;
}

/**
 * Views for one site item's URL: a service's layers, or the single layer.
 * A site's catalog points at many servers, some secured, moved or down, so
 * an item whose metadata cannot be read has no views (and a warning) rather
 * than failing every listing that visits it, such as `duckdb_views()`.
 */
export async function itemViews(url: string): Promise<DiscoveredView[]> {
  const target = classifyUrl(url);
  try {
    return target.kind === "service" ? await serviceViews(target.url) : await layerViews(target.url);
  } catch (err) {
    const why = isAuthError(err) ? " (token-secured services are not supported)" : "";
    log.warn(`skipping ${target.url}: ${(err as Error).message}${why}`);
    return [];
  }
}

/** Forget memoized site listings (tests). */
export function clearHubCache(): void {
  siteMemo.clear();
}
