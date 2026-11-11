// Unit tests. The SQL-level tests live in test/sql and run through DuckDB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Arguments, type PushdownFilters, VgiClient } from "@query-farm/vgi";
import { subprocessConnect } from "@query-farm/vgi-rpc";
import { viewDefinition } from "../src/discovery.ts";
import { attributeFields, classifyUrl, esriToGeoJson, supportsGeoJson } from "../src/esri.ts";
import { getJson } from "../src/http.ts";
import { assignNames, sqlName } from "../src/naming.ts";
import { decodeSettings, encodeSettings, settingsFromOptions } from "../src/options.ts";
import { FIRST_PAGE, pageSize, pagingMode } from "../src/query.ts";
import { WhereBuilder } from "../src/where.ts";

const ROOT = join(import.meta.dir, "..");

// ------------------------------------------------------------------ where.ts

type Expr = PushdownFilters["filters"][number];
const colRef = (name: string): Expr => ({ node: "column_ref", columnIndex: 0, columnName: name }) as Expr;
const lit = (value: unknown): Expr => ({ node: "literal", valueRef: 0, field: {}, value }) as unknown as Expr;
const cmp = (op: string, left: Expr, right: Expr): Expr => ({ node: "comparison", op, left, right }) as Expr;
const inList = (name: string, values: unknown[], negated = false): Expr =>
  ({
    node: "in",
    expression: colRef(name),
    set: { kind: "literal", valueRef: 0, field: {}, values },
    negated,
  }) as unknown as Expr;
const call = (fn: string, name: string, value: string): Expr =>
  ({ node: "call", function: fn, arguments: [colRef(name), lit(value)] }) as unknown as Expr;

const where = new WhereBuilder(
  new Map([
    ["FIPS", "esriFieldTypeString"],
    ["ACRES", "esriFieldTypeDouble"],
    ["OBJECTID", "esriFieldTypeOID"],
    ["BIG", "esriFieldTypeBigInteger"],
    ["UPDATED", "esriFieldTypeDate"],
  ]),
);

describe("WhereBuilder", () => {
  test("string equality, quoting and IN", () => {
    expect(where.where([cmp("eq", colRef("FIPS"), lit("51'580"))])).toBe("FIPS = '51''580'");
    expect(where.where([inList("FIPS", ["a", "b"])])).toBe("FIPS IN ('a', 'b')");
  });

  test("numeric comparisons, flipped operands, bigint", () => {
    expect(where.where([cmp("gt", colRef("ACRES"), lit(1.5))])).toBe("ACRES > 1.5");
    expect(where.where([cmp("lt", lit(10), colRef("OBJECTID"))])).toBe("OBJECTID > 10");
    expect(where.where([cmp("ne", colRef("BIG"), lit(9007199254740993n))])).toBe("BIG <> 9007199254740993");
    expect(where.where([inList("OBJECTID", [1, 2], true)])).toBe("OBJECTID NOT IN (1, 2)");
  });

  test("predicates that could drop rows stay in DuckDB", () => {
    expect(where.where([cmp("ne", colRef("FIPS"), lit("x"))])).toBe("1=1"); // case-insensitive servers
    expect(where.where([cmp("ge", colRef("FIPS"), lit("1"))])).toBe("1=1"); // collation-dependent
    expect(where.where([inList("FIPS", ["a"], true)])).toBe("1=1");
    expect(where.where([cmp("gt", colRef("UPDATED"), lit(0))])).toBe("1=1"); // dates
    expect(where.where([cmp("eq", colRef("ACRES"), lit("1"))])).toBe("1=1"); // type mismatch
    expect(where.where([cmp("eq", colRef("geometry"), lit("x"))])).toBe("1=1"); // not an attribute
    expect(where.where([cmp("gt", colRef("ACRES"), lit(Number.NaN))])).toBe("1=1");
  });

  test("casts: through literals, never through columns", () => {
    const castLit = { node: "cast", expression: lit(5), typeRef: 0, field: {} } as unknown as Expr;
    const castCol = { node: "cast", expression: colRef("FIPS"), typeRef: 0, field: {} } as unknown as Expr;
    expect(where.where([cmp("eq", colRef("OBJECTID"), castLit)])).toBe("OBJECTID = 5");
    expect(where.where([cmp("eq", castCol, lit(51580))])).toBe("1=1");
  });

  test("AND keeps what translates; OR needs every branch", () => {
    const ok = cmp("eq", colRef("FIPS"), lit("1"));
    const bad = cmp("ne", colRef("FIPS"), lit("2"));
    expect(where.where([{ node: "and", children: [ok, bad] } as Expr])).toBe("(FIPS = '1')");
    expect(where.where([{ node: "or", children: [ok, bad] } as Expr])).toBe("1=1");
    expect(where.where([{ node: "or", children: [ok, cmp("gt", colRef("ACRES"), lit(2))] } as Expr])).toBe(
      "(FIPS = '1') OR (ACRES > 2)",
    );
    expect(where.where([ok, cmp("gt", colRef("ACRES"), lit(2))])).toBe("(FIPS = '1') AND (ACRES > 2)");
  });

  test("IS NULL and LIKE-style calls", () => {
    expect(where.where([{ node: "is_null", expression: colRef("ACRES"), negated: true } as Expr])).toBe(
      "ACRES IS NOT NULL",
    );
    expect(where.where([call("starts_with", "FIPS", "51")])).toBe("FIPS LIKE '51%'");
    expect(where.where([call("contains", "FIPS", "o'k")])).toBe("FIPS LIKE '%o''k%'");
    expect(where.where([call("starts_with", "FIPS", "5_1")])).toBe("1=1"); // wildcard in the text
  });
});

// ------------------------------------------------------------------ esri.ts

describe("esri helpers", () => {
  test("classifyUrl", () => {
    expect(classifyUrl("https://h/arcgis/rest/services/A/B/FeatureServer/3/?f=json")).toEqual({
      kind: "layer",
      url: "https://h/arcgis/rest/services/A/B/FeatureServer/3",
      serviceUrl: "https://h/arcgis/rest/services/A/B/FeatureServer",
      layerId: 3,
    });
    expect(classifyUrl("https://h/arcgis/rest/services/B/MapServer").kind).toBe("service");
    expect(classifyUrl("https://h/arcgis/rest/services").kind).toBe("directory");
    expect(classifyUrl("https://h/arcgis/rest/services/Folder/").kind).toBe("directory");
    expect(() => classifyUrl("https://data.example.gov/datasets/abc")).toThrow(/unsupported ArcGIS URL/);
    expect(() => classifyUrl("ftp://h/x/FeatureServer/0")).toThrow(/http/);
    expect(() => classifyUrl("not a url")).toThrow(/valid URL/);
  });

  test("sqlName: readable, unquoted-safe identifiers", () => {
    expect(sqlName("Tax Parcels (2024)")).toBe("tax_parcels_2024");
    expect(sqlName("Économie")).toBe("economie");
    expect(sqlName("!!!")).toBe("unnamed");
    // Leading digits get "_", not an arbitrary prefix.
    expect(sqlName("911 Addresses")).toBe("_911_addresses");
    expect(sqlName("> 49,999")).toBe("_49_999");
    // Identifier-like names split at CamelCase, acronyms kept whole.
    expect(sqlName("USGSImageryIndex")).toBe("usgs_imagery_index");
    // Adjacent acronyms cannot be split without a dictionary.
    expect(sqlName("USGSNAIPImageryIndex")).toBe("usgsnaip_imagery_index");
    expect(sqlName("3DEPElevationIndex")).toBe("_3dep_elevation_index");
    expect(sqlName("NHDPlus_HR_Index")).toBe("nhd_plus_hr_index");
    expect(sqlName("USTopoAvailability")).toBe("us_topo_availability");
    expect(sqlName("VA_Base_Layers_VA_Parcels")).toBe("va_base_layers_va_parcels");
    // Names with spaces are not split (McDonald County, not mc_donald_county).
    expect(sqlName("McDonald County")).toBe("mcdonald_county");
  });

  test("pageSize: small first page with geometry, growing to maxRecordCount", () => {
    const paged = { maxRecordCount: 2000, advancedQueryCapabilities: { supportsPagination: true } } as never;
    expect([0, 1, 2, 3, 9].map((n) => pageSize(paged, n, true))).toEqual([FIRST_PAGE, 400, 1600, 2000, 2000]);
    // Attribute-only pages are small: full pages from the start.
    expect(pageSize(paged, 0, false)).toBe(2000);
    // A layer smaller than the first page: never more than it allows.
    expect(
      pageSize({ maxRecordCount: 2, advancedQueryCapabilities: { supportsPagination: true } } as never, 0, true),
    ).toBe(2);
    // No pagination support: ArcGIS ignores resultRecordCount, so none is sent.
    const unpaged = { maxRecordCount: 2000, advancedQueryCapabilities: { supportsPagination: false } } as never;
    expect(pageSize(unpaged, 0, true)).toBe(undefined);
  });

  test("assignNames: collisions qualify every member, by group then id", () => {
    // USGS 3DEPElevationIndex repeats layers under two group layers.
    const usgs = [
      { name: "1 meter", groups: ["DEM Product Index"], id: 1 },
      { name: "Lidar Point Cloud", groups: ["Source Data Index - Lidar, Ifsar, DEM"], id: 8 },
      { name: "Topobathy AOI", groups: ["Topobathymetric Data Index"], id: 13 },
      { name: "1 Meter", groups: ["Query"], id: 18 },
      { name: "Lidar Point Cloud", groups: ["Query"], id: 24 },
      { name: "Ifsar DSM (Alaska only) Project", groups: ["Query"], id: 25 },
    ];
    expect(assignNames(usgs)).toEqual([
      "dem_product_index_1_meter",
      "source_data_index_lidar_ifsar_dem_lidar_point_cloud",
      "topobathy_aoi",
      "query_1_meter",
      "query_lidar_point_cloud",
      "ifsar_dsm_alaska_only_project",
    ]);
    // Stable: the same structure in another order gives the same names.
    const reversed = assignNames([...usgs].reverse());
    expect(reversed.reverse()).toEqual(assignNames(usgs));
    // Nested groups: the innermost group first, then the next one out.
    expect(
      assignNames([
        { name: "Roads", groups: ["2020", "Local"], id: 3 },
        { name: "Roads", groups: ["2024", "Local"], id: 7 },
      ]),
    ).toEqual(["_2020_local_roads", "_2024_local_roads"]);
    // No groups to tell them apart: every member gets its id.
    expect(
      assignNames([
        { name: "Roads", id: 0 },
        { name: "roads", id: 4 },
      ]),
    ).toEqual(["roads_0", "roads_4"]);
    // Reserved names are avoided.
    expect(assignNames([{ name: "Main", id: "FeatureServer" }], ["main"])).toEqual(["main_feature_server"]);
  });

  test("attributeFields drops unsupported and reserved fields", () => {
    const fields = attributeFields({
      geometryType: "esriGeometryPoint",
      fields: [
        { name: "OBJECTID", type: "esriFieldTypeOID" },
        { name: "Shape", type: "esriFieldTypeGeometry" },
        { name: "Photo", type: "esriFieldTypeBlob" },
        { name: "Geometry", type: "esriFieldTypeString" },
        { name: "NAME", type: "esriFieldTypeString" },
      ],
    });
    expect(fields.map((f) => f.name)).toEqual(["OBJECTID", "NAME"]);
    expect(supportsGeoJson({ supportedQueryFormats: "JSON, geoJSON, PBF" })).toBe(true);
    expect(supportsGeoJson({ supportedQueryFormats: "JSON" })).toBe(false);
  });

  test("esriToGeoJson", () => {
    expect(esriToGeoJson({ x: 1, y: 2 })).toEqual({ type: "Point", coordinates: [1, 2] });
    expect(esriToGeoJson({ x: Number.NaN, y: 2 })).toBeNull();
    expect(
      esriToGeoJson({
        paths: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      }),
    ).toEqual({
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    });
    expect(esriToGeoJson({ points: [[0, 0]] })).toEqual({ type: "MultiPoint", coordinates: [[0, 0]] });
    const outerA = [
      [0, 0],
      [0, 10],
      [10, 10],
      [10, 0],
      [0, 0],
    ]; // clockwise
    const hole = [
      [2, 2],
      [4, 2],
      [4, 4],
      [2, 4],
      [2, 2],
    ]; // counter-clockwise
    const outerB = [
      [20, 0],
      [20, 5],
      [25, 5],
      [25, 0],
      [20, 0],
    ];
    expect(esriToGeoJson({ rings: [outerA, hole] })).toEqual({ type: "Polygon", coordinates: [outerA, hole] });
    expect(esriToGeoJson({ rings: [outerA, outerB, hole] })).toEqual({
      type: "MultiPolygon",
      coordinates: [[outerA, hole], [outerB]],
    });
    expect(esriToGeoJson(null)).toBeNull();
    expect(esriToGeoJson({ rings: [] })).toBeNull();
  });

  test("pagingMode", () => {
    expect(pagingMode({ objectIdField: "OID", advancedQueryCapabilities: { supportsOrderBy: true } })).toBe("keyset");
    expect(pagingMode({ objectIdField: "OID", advancedQueryCapabilities: { supportsPagination: true } })).toBe(
      "offset",
    );
    expect(pagingMode({ objectIdField: "OID" })).toBe("single");
  });

  test("viewDefinition escapes the URL", () => {
    expect(viewDefinition("https://h/x'y/FeatureServer/0")).toBe(
      "SELECT * FROM main.arcgis_query('https://h/x''y/FeatureServer/0')",
    );
  });
});

// ------------------------------------------------------------------ options.ts

describe("attach options", () => {
  test("defaults, validation and round trip", () => {
    expect(settingsFromOptions({})).toEqual({ url: null, precision: 7 });
    expect(settingsFromOptions({ url: "https://h/arcgis/rest/services", precision: 3 })).toEqual({
      url: "https://h/arcgis/rest/services",
      precision: 3,
    });
    expect(() => settingsFromOptions({ precision: 16 })).toThrow(/precision/);
    expect(() => settingsFromOptions({ precision: 1.5 })).toThrow(/precision/);
    const encoded = encodeSettings({ url: "https://h/x/MapServer", precision: 4 });
    expect(decodeSettings(encoded)).toEqual({ url: "https://h/x/MapServer", precision: 4 });
    expect(decodeSettings(new Uint8Array(16))).toEqual({ url: null, precision: 7 });
    expect(decodeSettings(null)).toEqual({ url: null, precision: 7 });
  });
});

// ------------------------------------------------------- worker + mock ArcGIS

describe("against the worker and the mock ArcGIS server", () => {
  let client: VgiClient;
  let mock: ReturnType<typeof Bun.spawn>;
  let services: string;

  beforeAll(async () => {
    // A client that launches the worker as a subprocess, the way DuckDB does.
    client = new VgiClient(subprocessConnect([process.execPath, "run", join(ROOT, "src", "worker.ts")]));
    // The mock prints PORT:<n> once it is listening; flaky mode exercises the retry path.
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
    if (!port) throw new Error(`mock ArcGIS server did not report a port: ${text}`);
    services = `http://127.0.0.1:${port}/arcgis/rest/services`;
  });

  afterAll(() => {
    client?.close();
    mock?.kill();
  });

  async function query(url: string) {
    const rows: Record<string, unknown>[] = [];
    for await (const page of client.tableFunctionRows({
      functionName: "arcgis_query",
      arguments: new Arguments([url]),
      int64: "bigint",
    })) {
      rows.push(...page);
    }
    return rows;
  }

  /** WKB type code (little-endian ISO) of a geometry cell. */
  const wkbType = (v: unknown) =>
    new DataView((v as Uint8Array).buffer, (v as Uint8Array).byteOffset).getUint32(1, true);

  test("pages through a layer (keyset) and returns WKB geometry", async () => {
    const rows = await query(`${services}/Demo/Parcels/FeatureServer/0`);
    expect(rows.map((r) => r.OBJECTID)).toEqual([1, 2, 3, 4, 5]);
    expect(rows[2]?.ACRES).toBeNull();
    expect(wkbType(rows[3]?.geometry)).toBe(6); // MultiPolygon
    // The default precision (7) rounds coordinates: first vertex of the first ring.
    const g = rows[4]?.geometry as Uint8Array;
    const view = new DataView(g.buffer, g.byteOffset);
    expect([view.getFloat64(13, true), view.getFloat64(21, true)]).toEqual([-77.1234568, 37.9876543]);
  });

  test("converts Esri JSON for servers without GeoJSON", async () => {
    const rows = await query(`${services}/Demo/Parcels/FeatureServer/1`);
    expect(rows.map((r) => wkbType(r.geometry))).toEqual([1, 1, 1]);
  });

  test("offset paging and tables without geometry", async () => {
    expect((await query(`${services}/Roads/MapServer/0`)).map((r) => r.NAME)).toEqual([
      "Main St",
      "Route 29",
      "Oak Ave",
    ]);
    const owners = await query(`${services}/Demo/Parcels/FeatureServer/2`);
    expect(owners.length).toBe(3);
    expect("geometry" in (owners[0] ?? {})).toBe(false);
  });

  test("refuses a truncated result it cannot page", async () => {
    await expect(query(`${services}/Legacy/MapServer/0`)).rejects.toThrow(/truncated/);
  });

  test("rejects a URL that is not a layer at bind", async () => {
    await expect(query(`${services}/Roads/MapServer`)).rejects.toThrow(/pattern|layer URL/i);
  });

  test("getJson surfaces ArcGIS error bodies and HTTP errors", async () => {
    await expect(getJson(`${services}/Nope/FeatureServer?f=json`)).rejects.toThrow(/ArcGIS error 404/);
    await expect(getJson(`${services.replace("/arcgis/rest/services", "")}/missing`)).rejects.toThrow(/HTTP 404/);
  });
});
