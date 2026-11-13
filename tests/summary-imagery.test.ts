import { expect, test } from "bun:test";
import { imageServiceUrl, samplePoints } from "../src/imagery.ts";
import { summaryQuery } from "../src/summary.ts";

test("summary filters preserve ArcGIS SQL and validate WGS84 bounds", () => {
  const args = { url: "https://example.gov/MapServer/0", where_clause: "STATE = '36'", bbox: "-80,35,-70,45" };
  const q = summaryQuery(args);
  expect(q.get("where")).toBe("STATE = '36'");
  expect(q.get("spatialRel")).toBe("esriSpatialRelIntersects");
  expect(q.get("inSR")).toBe("4326");
  for (const bbox of ["0,0,1", ",0,1,1", "170,-10,-170,10", "-181,0,0,1", "0,-91,1,1", "0,0,Infinity,1"])
    expect(() => summaryQuery({ ...args, bbox })).toThrow(/bbox/);
  expect(() => summaryQuery({ ...args, where_clause: " " })).toThrow(/where_clause/);
});

test("image sampling accepts only ImageServer URLs and bounded point arrays", () => {
  expect(imageServiceUrl("https://example.gov/ImageServer/?f=pjson")).toBe("https://example.gov/ImageServer");
  expect(() => imageServiceUrl("https://example.gov/MapServer/0")).toThrow(/ImageServer/);
  expect(samplePoints("[]")).toEqual([]);
  expect(samplePoints("[[-180,-90],[180,90]]")).toEqual([
    [-180, -90],
    [180, 90],
  ]);
  for (const input of ["null", "{}", "[1,2]", "[[181,0]]", "[[0,91]]", "[[null,1]]", "[[1,2,3]]", '[["1",2]]', "bad"])
    expect(() => samplePoints(input)).toThrow(/points_json/);
  expect(() => samplePoints(JSON.stringify(Array.from({ length: 10001 }, () => [0, 0])))).toThrow(/10000/);
});
