// Unit tests for ArcGIS Hub URL support (src/hub.ts), in process, against the mock server.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { clearMetadataCache } from "../src/http.ts";
import {
  clearHubCache,
  type HubItem,
  hubSiteSchemas,
  hubSlugify,
  itemSchemas,
  itemViews,
  parseHubPath,
  resolveUrl,
  siteGroups,
  slugify,
} from "../src/hub.ts";

const ROOT = join(import.meta.dir, "..");

describe("Hub URL parsing", () => {
  test("parseHubPath", () => {
    const id = "b7ec5d68d8114b1fb2bfbf4665989eb3";
    expect(parseHubPath("/")).toEqual({ kind: "site" });
    expect(parseHubPath("/search")).toEqual({ kind: "site" });
    expect(parseHubPath("/pages/about")).toEqual({ kind: "site" });
    expect(parseHubPath("/datasets")).toEqual({ kind: "site" });
    expect(parseHubPath(`/datasets/${id}_0`)).toEqual({ kind: "item", itemId: id, layerId: 0 });
    expect(parseHubPath(`/datasets/${id.toUpperCase()}_12/explore`)).toEqual({ kind: "item", itemId: id, layerId: 12 });
    expect(parseHubPath(`/maps/${id}/about`)).toEqual({ kind: "item", itemId: id });
    expect(parseHubPath(`/items/${id}`)).toEqual({ kind: "item", itemId: id });
    expect(parseHubPath("/datasets/CALTRANS::caltrans-districts/about")).toEqual({
      kind: "slug",
      orgKey: "CALTRANS",
      slug: "caltrans-districts",
    });
    expect(parseHubPath("/datasets/CALTRANS%3A%3Acaltrans-districts")).toEqual({
      kind: "slug",
      orgKey: "CALTRANS",
      slug: "caltrans-districts",
    });
    expect(parseHubPath("/datasets/Parcels-2024")).toEqual({ kind: "slug", slug: "parcels-2024" });
  });

  test("slugify follows Hub's title slugs", () => {
    expect(slugify("Caltrans Districts")).toBe("caltrans-districts");
    expect(slugify("Adopt-A-Highway (AAH) All Highways")).toBe("adopt-a-highway-aah-all-highways");
    expect(slugify("  Économie -- 2024  ")).toBe("economie-2024");
    expect(slugify("Fish and Game Code 11000 [ds3417]")).toBe("fish-and-game-code-11000-ds3417");
    // hub-common drops punctuation rather than splitting on it.
    expect(slugify("California's Parks")).toBe("california-s-parks");
    expect(hubSlugify("California's Parks")).toBe("californias-parks");
    expect(hubSlugify("Districts - Fish & Game")).toBe("districts-fish-game");
  });

  test("siteGroups reads catalogV2 and the older catalog", () => {
    expect(
      siteGroups({
        catalogV2: { scopes: { item: { filters: [{ predicates: [{ group: { any: ["a", "b", "a"] } }] }] } } },
        catalog: { groups: ["old"] },
      }),
    ).toEqual(["a", "b"]);
    expect(siteGroups({ catalogV2: { scopes: { item: { filters: [] } } }, catalog: { groups: ["x", "y"] } })).toEqual([
      "x",
      "y",
    ]);
    expect(siteGroups({ catalog: { groups: "solo" } })).toEqual(["solo"]);
    expect(siteGroups({})).toEqual([]);
  });

  test("itemSchemas: dedupes twins, skips non-REST items, names stably", () => {
    const items: HubItem[] = [
      { id: "b", title: "Parcels", type: "Map Service", url: "https://h/arcgis/rest/services/P/MapServer" },
      { id: "c", title: "Parcels", type: "Feature Service", url: "https://h/arcgis/rest/services/P/FeatureServer" },
      { id: "d", title: "Zoning", type: "Feature Service", url: "https://h/arcgis/rest/services/Z/FeatureServer/0" },
      { id: "e", title: "Zoning", type: "Feature Service", url: "https://h/arcgis/rest/services/Z2/FeatureServer" },
      { id: "f", title: "App", type: "Feature Service", url: "https://experience.arcgis.com/experience/f" },
      { id: "g", title: "Nothing", type: "Feature Service", url: null },
    ];
    const schemas = itemSchemas(items);
    expect(schemas.map((s) => [s.name, s.itemId])).toEqual([
      ["parcels", "c"],
      ["zoning_d", "d"],
      ["zoning_e", "e"],
    ]);
    expect(itemSchemas([...items].reverse())).toEqual(schemas);
    // Owners qualify duplicates before ids do.
    expect(
      itemSchemas([
        { ...(items[2] as HubItem), owner: "CountyA" },
        { ...(items[3] as HubItem), owner: "CountyB" },
      ]).map((s) => s.name),
    ).toEqual(["county_a_zoning", "county_b_zoning"]);
  });
});

describe("Hub resolution against the mock", () => {
  let mock: ReturnType<typeof Bun.spawn>;
  let base: string;
  const saved = { hub: process.env.ARCGIS_HUB_API, portal: process.env.ARCGIS_PORTAL_API };

  beforeAll(async () => {
    mock = Bun.spawn([process.env.PYTHON ?? "python3", join(ROOT, "test", "mock_api", "server.py")], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, MOCK_API_FLAKY: "1" },
    });
    const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const port = text.match(/^PORT:(\d+)/)?.[1];
    if (!port) throw new Error(`mock server did not report a port: ${text}`);
    base = `http://127.0.0.1:${port}`;
    process.env.ARCGIS_HUB_API = base;
    process.env.ARCGIS_PORTAL_API = `${base}/sharing/rest`;
    clearMetadataCache();
    clearHubCache();
  });

  afterAll(() => {
    mock?.kill();
    for (const [key, value] of [
      ["ARCGIS_HUB_API", saved.hub],
      ["ARCGIS_PORTAL_API", saved.portal],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const rest = (path: string) => `${base}/arcgis/rest/services/${path}`;

  test("REST URLs stay synchronous and unchanged", async () => {
    expect(await resolveUrl(`${rest("Roads/MapServer/0")}?f=json`)).toEqual({
      kind: "layer",
      url: rest("Roads/MapServer/0"),
      serviceUrl: rest("Roads/MapServer"),
      layerId: 0,
    });
    await expect(resolveUrl(`${rest("Roads/MapServer/0/query")}`)).rejects.toThrow(/unsupported ArcGIS URL/);
  });

  test("a site URL (any non-dataset page) is the site", async () => {
    for (const url of [base, `${base}/search?q=x`, `${base}/pages/about`]) {
      expect(await resolveUrl(url)).toEqual({
        kind: "hub_site",
        url: base,
        siteId: "a0000000000000000000000000000001",
        title: "Mock Open Data",
        orgKey: "MOCKORG",
      });
    }
  });

  test("a non-Hub, non-REST URL fails clearly", async () => {
    await expect(resolveUrl("https://not-a-hub.example.com/some/page")).rejects.toThrow(
      /not-a-hub\.example\.com is not an ArcGIS Hub site/,
    );
    await expect(resolveUrl("https://not-a-hub.example.com/datasets/parcels")).rejects.toThrow(/not an ArcGIS Hub/);
  });

  test("dataset ids: <itemId>_<n>, bare <itemId>, suffixes", async () => {
    const one = "1".repeat(32);
    expect((await resolveUrl(`https://elsewhere.example.org/datasets/${one}_0/explore?location=1`)).url).toBe(
      rest("Demo/Parcels/FeatureServer/0"),
    );
    expect(await resolveUrl(`${base}/maps/${one}`)).toEqual({
      kind: "service",
      url: rest("Demo/Parcels/FeatureServer"),
    });
    // A layer item keeps its layer.
    expect((await resolveUrl(`${base}/datasets/${"3".repeat(32)}_0`)).url).toBe(rest("Roads/MapServer/0"));
    await expect(resolveUrl(`${base}/datasets/${"7".repeat(32)}`)).rejects.toThrow(/no FeatureServer or MapServer URL/);
    await expect(resolveUrl(`${base}/datasets/${"0".repeat(32)}_0`)).rejects.toThrow(/could not resolve/);
  });

  test("slugs: title match, org disambiguation, ambiguity, not found", async () => {
    expect((await resolveUrl(`${base}/datasets/mockorg::tax-parcels/about`)).url).toBe(
      rest("Demo/Parcels/FeatureServer"),
    );
    expect((await resolveUrl(`${base}/datasets/road-centerlines`)).url).toBe(rest("Roads/MapServer/0"));
    // Two "Zoning" items: the org key (or the site's own org) picks one.
    expect((await resolveUrl(`${base}/datasets/MOCKB::zoning`)).url).toBe(rest("3DEPIndex/MapServer"));
    expect((await resolveUrl(`${base}/datasets/zoning`)).url).toBe(rest("Legacy/MapServer"));
    await expect(resolveUrl(`${base}/datasets/hydrants`)).rejects.toThrow(/ambiguous: 2 items match.*Hydrants/);
    await expect(resolveUrl(`${base}/datasets/parcel-story`)).rejects.toThrow(/StoryMap without a FeatureServer/);
    await expect(resolveUrl(`${base}/datasets/no-such-thing`)).rejects.toThrow(/not found/);
  });

  test("site schemas: both catalog formats, paging, dedupe, names", async () => {
    const site = await resolveUrl(base);
    if (site.kind !== "hub_site") throw new Error("expected a site");
    const schemas = await hubSiteSchemas(site);
    expect(schemas.map((s) => s.name)).toEqual([
      "county_a_zoning",
      "county_b_zoning",
      `mockcounty_hydrants_${"8".repeat(32)}`,
      `mockcounty_hydrants_${"9".repeat(32)}`,
      "road_centerlines",
      "secured_data",
      "tax_parcels",
    ]);
    const parcels = schemas.find((s) => s.name === "tax_parcels");
    expect(parcels?.serviceUrl).toBe(rest("Demo/Parcels/FeatureServer"));
    expect(parcels?.comment).toContain("Tax Parcels. Parcel polygons, owners and address points");

    const legacy = await resolveUrl("https://legacy-hub.example.org/");
    if (legacy.kind !== "hub_site") throw new Error("expected a site");
    expect((await hubSiteSchemas(legacy)).map((s) => s.name)).toEqual(["road_centerlines", "tax_parcels"]);
  });

  test("item views: services, layers, secured items", async () => {
    expect((await itemViews(rest("Demo/Parcels/FeatureServer"))).map((v) => v.name)).toEqual([
      "tax_parcels",
      "address_points",
      "owners",
    ]);
    expect((await itemViews(rest("Roads/MapServer/0"))).map((v) => v.name)).toEqual(["road_centerlines"]);
    expect(await itemViews(rest("Secured/FeatureServer"))).toEqual([]);
    // A moved or missing service: no views, not an error.
    expect(await itemViews(rest("Nope/FeatureServer"))).toEqual([]);
  });
});
