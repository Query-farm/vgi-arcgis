import { expect, test } from "bun:test";
import type { LayerMeta } from "../src/esri.ts";
import { objectIdField, readPage, type ScanState } from "../src/paging.ts";

const state = (): ScanState => ({ lastOid: 0, started: false, offset: 0, pages: 0, done: false, idScan: "" });
const meta: LayerMeta = {
  objectIdField: "OBJECTID",
  maxRecordCount: 2,
  advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: false },
};
const query = () => new URLSearchParams({ where: "1=1", f: "json", outFields: "OBJECTID", resultRecordCount: "2" });

test("MapServer discovers a numeric OID from fields rather than a string display ID", () => {
  expect(
    objectIdField({
      objectIdField: "OID",
      fields: [
        { name: "OID", type: "esriFieldTypeString" },
        { name: "OBJECTID", type: "esriFieldTypeOID" },
      ],
    }),
  ).toBe("OBJECTID");
  expect(objectIdField({ fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }] })).toBe("OBJECTID");
});

test("empty and short offset pages advance the requested spatial window", async () => {
  const offsets: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const offset = new URL(req.url).searchParams.get("resultOffset") as string;
      offsets.push(offset);
      return Response.json({
        features: offset === "0" ? [] : [{ attributes: { OBJECTID: Number(offset) } }],
        exceededTransferLimit: offset !== "4",
      });
    },
  });
  try {
    const cursor = state();
    const rows = [];
    while (!cursor.done) rows.push(...(await readPage(String(server.url), query(), meta, cursor)));
    expect(offsets).toEqual(["0", "2", "4"]);
    expect(rows.map((r) => r.attributes?.OBJECTID)).toEqual([2, 4]);
  } finally {
    server.stop(true);
  }
});

test("empty keyset pages fall back to IDs; truncated ID batches shrink and resume after a cache miss", async () => {
  const enumeration: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const q = new URL(req.url).searchParams;
      if (q.get("returnIdsOnly")) {
        enumeration.push(q.get("where") as string);
        return Response.json({ objectIds: [3, 2, 1, 2] });
      }
      if (q.has("objectIds")) {
        const ids = (q.get("objectIds") as string).split(",").map(Number);
        return Response.json({
          features: [{ attributes: { OBJECTID: ids[0] } }],
          exceededTransferLimit: ids.length > 1,
        });
      }
      return Response.json({ features: [], exceededTransferLimit: true });
    },
  });
  try {
    const layer = { ...meta, advancedQueryCapabilities: { supportsOrderBy: true, supportsPagination: true } };
    let cursor = state();
    expect((await readPage(String(server.url), query(), layer, cursor))[0]?.attributes?.OBJECTID).toBe(1);
    // Portable state survives serialization. Changing the scan ID simulates a
    // different HTTP worker with no cache, without retaining the whole ID array.
    cursor = { ...JSON.parse(JSON.stringify(cursor)), idScan: crypto.randomUUID() };
    const rows = [];
    while (!cursor.done) rows.push(...(await readPage(String(server.url), query(), layer, cursor)));
    expect(rows.map((r) => r.attributes?.OBJECTID)).toEqual([2, 3]);
    expect(enumeration).toEqual(["1=1", "(1=1) AND OBJECTID > 1"]);
    expect(JSON.stringify(cursor).length).toBeLessThan(180);
  } finally {
    server.stop(true);
  }
});

test("missing features and non-advancing keyset cursors fail rather than hang or truncate", async () => {
  let body: object = {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      Response.json(
        new URL(req.url).searchParams.has("returnIdsOnly") ? { objectIds: [Number.MAX_SAFE_INTEGER + 1] } : body,
      ),
  });
  try {
    await expect(readPage(String(server.url), query(), meta, state())).rejects.toThrow(/missing features/);
    body = { features: [{ attributes: { OBJECTID: 1 } }], exceededTransferLimit: true };
    const cursor = { ...state(), started: true, lastOid: 1 };
    await expect(
      readPage(String(server.url), query(), { ...meta, advancedQueryCapabilities: { supportsOrderBy: true } }, cursor),
    ).rejects.toThrow(/did not advance/);
    body = { features: [], exceededTransferLimit: true, objectIds: [Number.MAX_SAFE_INTEGER + 1] };
    await expect(
      readPage(String(server.url), query(), { ...meta, advancedQueryCapabilities: {} }, state()),
    ).rejects.toThrow(/unsafe integer/);
  } finally {
    server.stop(true);
  }
});
