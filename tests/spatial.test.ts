import { describe, expect, test } from "bun:test";
import type { PushdownFilters } from "@query-farm/vgi";
import { padBox, spatialFilterBox, spatialQueryParams } from "../src/spatial.ts";
import { geojsonToWkb, wkbExtent } from "../src/wkb.ts";

type Expr = PushdownFilters["filters"][number];

const IE = { namespace: "duckdb.spatial", name: "intersects_extent", version: 1 };
const col = (name: string): Expr => ({ node: "column_ref", columnIndex: 0, columnName: name }) as unknown as Expr;
const lit = (value: unknown): Expr => ({ node: "literal", value }) as unknown as Expr;
const ie = (a: Expr, b: Expr): Expr => ({ node: "call", function: IE, arguments: [a, b] }) as unknown as Expr;
const box = (xmin: number, ymin: number, xmax: number, ymax: number) =>
  geojsonToWkb({
    type: "Polygon",
    coordinates: [
      [
        [xmin, ymin],
        [xmax, ymin],
        [xmax, ymax],
        [xmin, ymax],
        [xmin, ymin],
      ],
    ],
  });
const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

describe("geojsonToWkb", () => {
  test("matches DuckDB's WKB for each GeoJSON type", () => {
    // Expected bytes are DuckDB 2.0's ST_AsWKB of the same geometry.
    expect(Buffer.from(geojsonToWkb({ type: "Point", coordinates: [1, 2] })).toString("hex")).toBe(
      "0101000000000000000000f03f0000000000000040",
    );
    expect(Buffer.from(geojsonToWkb({ type: "Point", coordinates: [] })).toString("hex")).toBe(
      "0101000000000000000000f87f000000000000f87f",
    );
    expect(
      Buffer.from(
        geojsonToWkb({
          type: "MultiLineString",
          coordinates: [
            [
              [0, 0],
              [0, 5],
            ],
          ],
        }),
      ).toString("hex"),
    ).toBe("0105000000010000000102000000020000000000000000000000000000000000000000000000000000000000000000001440");
    expect(Buffer.from(geojsonToWkb({ type: "Polygon", coordinates: [] })).toString("hex")).toBe("010300000000000000");
  });

  test("rejects malformed geometry", () => {
    expect(() => geojsonToWkb({ type: "Point", coordinates: [1] })).toThrow();
    expect(() => geojsonToWkb({ type: "Circle", coordinates: [1, 2] })).toThrow(/unsupported/);
  });
});

describe("wkbExtent", () => {
  test("follows DuckDB core rules", () => {
    expect(wkbExtent(box(0, 0, 2, 1))).toEqual({ vertices: 5, xmin: 0, ymin: 0, xmax: 2, ymax: 1 });
    expect(wkbExtent(hex("0101000000000000000000f87f000000000000f87f")).vertices).toBe(0); // POINT EMPTY
    // LINESTRING(nan nan, 0.25 0.25): a NaN vertex outside a POINT makes both axes unbounded.
    const e = wkbExtent(hex("010200000002000000000000000000f87f000000000000f87f000000000000d03f000000000000d03f"));
    expect([e.vertices, e.xmin, e.xmax]).toEqual([2, -Infinity, Infinity]);
    // Big-endian and EWKB with an SRID read the same.
    expect(wkbExtent(hex("00000000013ff00000000000004000000000000000"))).toMatchObject({ xmin: 1, ymax: 2 });
    expect(wkbExtent(hex("0101000020e6100000000000000000f03f0000000000000040"))).toMatchObject({ xmin: 1, ymax: 2 });
    expect(() => wkbExtent(hex("0101000000"))).toThrow(/truncated/);
  });
});

describe("spatialFilterBox", () => {
  test("finds geometry && <constant> in either order and inside AND", () => {
    expect(spatialFilterBox([ie(col("geometry"), lit(box(0, 0, 1, 1)))], "geometry")).toEqual({
      xmin: 0,
      ymin: 0,
      xmax: 1,
      ymax: 1,
    });
    expect(spatialFilterBox([ie(lit(box(0, 0, 1, 1)), col("geometry"))], "geometry")?.xmax).toBe(1);
    const and = { node: "and", children: [ie(col("geometry"), lit(box(0, 0, 4, 4)))] } as unknown as Expr;
    expect(spatialFilterBox([and], "geometry")?.xmax).toBe(4);
  });

  test("sends the smallest of several boxes, never their intersection", () => {
    const filters = [ie(col("geometry"), lit(box(0, 0, 10, 10))), ie(col("geometry"), lit(box(5, 5, 6, 6)))];
    expect(spatialFilterBox(filters, "geometry")).toEqual({ xmin: 5, ymin: 5, xmax: 6, ymax: 6 });
  });

  test("ignores other columns, OR, empty and NaN constants, and malformed WKB", () => {
    expect(spatialFilterBox([ie(col("other"), lit(box(0, 0, 1, 1)))], "geometry")).toBeUndefined();
    const or = { node: "or", children: [ie(col("geometry"), lit(box(0, 0, 1, 1)))] } as unknown as Expr;
    expect(spatialFilterBox([or], "geometry")).toBeUndefined();
    const empty = hex("0101000000000000000000f87f000000000000f87f");
    expect(spatialFilterBox([ie(col("geometry"), lit(empty))], "geometry")).toBeUndefined();
    const nanX = hex("0101000000000000000000f87f000000000000f03f");
    expect(spatialFilterBox([ie(col("geometry"), lit(nanX))], "geometry")).toBeUndefined();
    expect(spatialFilterBox([ie(col("geometry"), lit(hex("0101")))], "geometry")).toBeUndefined();
  });
});

describe("padBox and spatialQueryParams", () => {
  test("pads for rounding and reprojection, and refuses boxes past the world edge", () => {
    const p = padBox({ xmin: -77.5, ymin: 37.5, xmax: -77.4, ymax: 37.6 }, 7);
    expect(p?.xmin).toBeLessThan(-77.5 - 2e-7);
    expect(p?.ymax).toBeGreaterThan(37.6 + 2e-7);
    // A coarse precision widens the box by at least the rounding step.
    expect((padBox({ xmin: 0, ymin: 0, xmax: 0, ymax: 0 }, 0)?.xmax ?? 0) >= 2).toBe(true);
    expect(padBox({ xmin: -180, ymin: 0, xmax: 0, ymax: 1 }, 7)).toBeUndefined();
  });

  test("sends a densified WGS84 ring with envelope semantics", () => {
    const q = spatialQueryParams({ xmin: 0, ymin: 0, xmax: 1, ymax: 2 });
    expect(q.spatialRel).toBe("esriSpatialRelEnvelopeIntersects");
    expect(q.geometryType).toBe("esriGeometryPolygon");
    expect(q.inSR).toBe("4326");
    const ring = JSON.parse(q.geometry as string).rings[0] as number[][];
    expect(ring.length).toBe(33);
    expect(ring[0]).toEqual(ring[ring.length - 1] as number[]);
    expect(Math.min(...ring.map((p) => p[0] as number))).toBe(0);
    expect(Math.max(...ring.map((p) => p[1] as number))).toBe(2);
  });
});
