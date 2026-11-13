/**
 * `arcgis_query(url)`: stream every feature of one ArcGIS layer or table.
 *
 * - The output schema comes from the layer's `?f=json` field list.
 * - Filters DuckDB pushes down become the ArcGIS `where` clause where that
 *   is safe (see where.ts), and are re-applied exactly to every batch
 *   (`autoApplyFilters`); only the projected columns are requested.
 * - Geometry arrives as GeoJSON (or, for servers without `f=geojson`, Esri
 *   JSON reshaped to GeoJSON), in WGS84 rounded to the ATTACH `precision`, and
 *   is emitted as a `geometry` GEOMETRY column (geoarrow WKB).
 * - `geometry && <constant>`, which DuckDB pushes for `&&` and derives from
 *   ST_Intersects/ST_Within/... against a constant, becomes an ArcGIS
 *   envelope-intersects query (see spatial.ts).
 * - Paging is keyset on the object id when the layer supports `orderBy`,
 *   `resultOffset` when it only supports pagination, and a single request
 *   otherwise (using object-ID batches if the server truncates it).
 */

import { batchFromColumns, binary, defineTableFunction, field, schema, utf8 } from "@query-farm/vgi";
import { resolveAuth, secretLookup } from "./auth.ts";
import { arrowType, attributeFields, esriToGeoJson, GEOMETRY, type LayerMeta, supportsGeoJson } from "./esri.ts";
import { ArcgisError, getMetadata, isAuthError, type RequestAuth } from "./http.ts";
import { resolveUrl } from "./hub.ts";
import { log } from "./log.ts";
import { column, objectTags } from "./meta.ts";
import { decodeSettings } from "./options.ts";
import { type Feature, objectIdField, pagingMode, readPage, type ScanState } from "./paging.ts";
import { padBox, spatialFilterBox, spatialQueryParams } from "./spatial.ts";
import { WhereBuilder } from "./where.ts";
import { geojsonToWkb } from "./wkb.ts";

export { pagingMode } from "./paging.ts";

interface QueryArgs {
  url: string;
}

/**
 * Fetch and check a layer's metadata; an ArcGIS Hub dataset URL is resolved
 * to its layer first (cached). @throws Error if the URL is not a layer.
 */
export async function layerMeta(url: string, auth?: RequestAuth | null): Promise<{ url: string; meta: LayerMeta }> {
  const target = await resolveUrl(url);
  if (target.kind !== "layer") {
    throw new Error(
      "arcgis_query needs a layer URL ending in /FeatureServer/<id> or /MapServer/<id>, or an ArcGIS Hub " +
        `dataset URL for one layer (.../datasets/<itemId>_<id>), got '${url}'` +
        (target.kind === "service" ? ` (a whole service, ${target.url})` : ""),
    );
  }
  const meta = (await getMetadata(`${target.url}?f=json`, auth)) as LayerMeta;
  if (!Array.isArray(meta.fields)) throw new ArcgisError(`${target.url} has no field list; is it a feature layer?`);
  return { url: target.url, meta };
}

/** Rows in the first page: small, so the first rows (and a LIMIT query) come back fast. */
export const FIRST_PAGE = 100;

/**
 * `resultRecordCount` for the next page. With geometry, pages run to megabytes,
 * so they start at FIRST_PAGE and grow fourfold to the layer's maxRecordCount:
 * the first rows (and a LIMIT query) arrive fast, and a long scan costs only a
 * couple of extra requests. Attribute-only pages are small; they use
 * maxRecordCount from the start. Undefined when the layer does not support
 * pagination: ArcGIS only honours resultRecordCount there, so its own page size
 * applies.
 */
export function pageSize(meta: LayerMeta, pages: number, withGeometry: boolean): number | undefined {
  if (!meta.advancedQueryCapabilities?.supportsPagination) return undefined;
  const max = meta.maxRecordCount ?? 1000;
  return withGeometry ? Math.min(max, FIRST_PAGE * 4 ** Math.min(pages, 10)) : max;
}

/** Coerce one attribute value to what its Arrow column expects. */
function coerce(esriType: string, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (esriType) {
    case "esriFieldTypeBigInteger":
      return typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v)));
    case "esriFieldTypeOID":
    case "esriFieldTypeInteger":
    case "esriFieldTypeSmallInteger":
    case "esriFieldTypeDouble":
    case "esriFieldTypeSingle": {
      const n = Number(v);
      return Number.isNaN(n) ? null : n;
    }
    case "esriFieldTypeDate": {
      const n = typeof v === "number" ? v : Date.parse(String(v));
      return Number.isNaN(n) ? null : n;
    }
    default:
      return typeof v === "string" ? v : String(v);
  }
}

export const arcgisQuery = defineTableFunction<QueryArgs, ScanState>({
  name: "arcgis_query",
  description: "Read the features of one ArcGIS FeatureServer/MapServer layer or table, with filter pushdown",
  args: { url: utf8() },
  argDocs: {
    url:
      "Layer or table URL, e.g. 'https://host/arcgis/rest/services/Folder/Name/FeatureServer/0'. " +
      "Also accepts an ArcGIS Hub / Open Data dataset page for one layer, e.g. " +
      "'https://gis.data.ca.gov/datasets/<itemId>_0' or '.../datasets/<orgKey>::<slug>'. " +
      "Query strings are ignored.",
  },
  argConstraints: {
    url: { pattern: "^https?://(.+/(FeatureServer|MapServer)/[0-9]+/?$|[^/]+/(datasets|maps|items)/[^/?#]+)" },
  },
  filterPushdown: true,
  projectionPushdown: true,
  // `geometry && <constant>` (bounding boxes intersect): sent to ArcGIS as an
  // envelope-intersects query, and re-applied exactly like every other filter.
  additionalFilterFunctions: [{ namespace: "duckdb.spatial", name: "intersects_extent", version: 1 }],
  // DuckDB drops every predicate it pushes down from its own plan, so the
  // worker must return exactly the matching rows. The ArcGIS `where` is only a
  // superset (see where.ts); the SDK re-applies all pushed predicates, with
  // DuckDB semantics, to each emitted batch.
  autoApplyFilters: true,

  onBind: async (params) => {
    // First pass (unless ATTACH credentials apply): also ask DuckDB for the
    // `arcgis` secret scoped to this URL; it re-binds with it. The schema is
    // still real when the layer is public, for clients that bind only once.
    const attach = params.bindCall.attach_opaque_data;
    const lookup = secretLookup(attach, params.args.url, params.resolvedSecretsProvided);
    let meta: LayerMeta;
    try {
      ({ meta } = await layerMeta(
        params.args.url,
        lookup ? null : resolveAuth(attach, params.secrets, params.args.url),
      ));
    } catch (err) {
      if (lookup && isAuthError(err)) return { outputSchema: schema([]), ...lookup };
      throw err;
    }
    const columns = attributeFields(meta).map((f) =>
      column(f.name, arrowType(f.type) as NonNullable<ReturnType<typeof arrowType>>, f.alias || f.name),
    );
    if (meta.geometryType) {
      columns.push(
        field(
          GEOMETRY,
          binary(),
          true,
          new Map([
            ["comment", "Feature geometry in WGS84 (EPSG:4326) longitude/latitude, rounded to the ATTACH precision."],
            ["ARROW:extension:name", "geoarrow.wkb"],
            ["ARROW:extension:metadata", "{}"],
          ]),
        ),
      );
    }
    return { outputSchema: schema(columns), ...lookup };
  },

  initialState: () => ({ lastOid: 0, started: false, offset: 0, pages: 0, done: false, idScan: "" }),

  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    // Re-derived on every call: tokens never travel in the state.
    const auth = resolveAuth(params.initCall.bind_call.attach_opaque_data, params.secrets, params.args.url);
    const { url, meta } = await layerMeta(params.args.url, auth);
    const settings = decodeSettings(params.initCall.bind_call.attach_opaque_data);
    const fields = attributeFields(meta);
    const fieldTypes = new Map(fields.map((f) => [f.name, f.type]));
    const filters = params.pushdownFilters?.filters ?? [];
    const where = new WhereBuilder(fieldTypes).where(filters);
    const box = meta.geometryType ? spatialFilterBox(filters, GEOMETRY) : undefined;
    const sendBox = box ? padBox(box, settings.precision) : undefined;
    const wanted = params.outputSchema.fields.map((f) => f.name);
    const attrs = wanted.filter((n) => n !== GEOMETRY);
    const wantGeometry = wanted.includes(GEOMETRY);
    const oid = objectIdField(meta);
    const mode = pagingMode(meta);
    const outFields = new Set(attrs);
    if (oid) outFields.add(oid);
    const geojson = supportsGeoJson(meta);

    const q = new URLSearchParams({
      where,
      outFields: outFields.size ? [...outFields].join(",") : "*",
      returnGeometry: String(wantGeometry && Boolean(meta.geometryType)),
      outSR: "4326",
      f: geojson ? "geojson" : "json",
    });
    if (wantGeometry) q.set("geometryPrecision", String(settings.precision));
    if (sendBox) for (const [k, v] of Object.entries(spatialQueryParams(sendBox))) q.set(k, v);
    const size = pageSize(meta, state.pages, wantGeometry && Boolean(meta.geometryType));
    if (size !== undefined && mode !== "single") q.set("resultRecordCount", String(size));
    if (state.offset === 0)
      log.debug(
        `arcgis_query ${url}: mode=${mode} where=${where} outFields=${q.get("outFields")}` +
          (sendBox ? ` box=${[sendBox.xmin, sendBox.ymin, sendBox.xmax, sendBox.ymax].join(",")}` : ""),
      );

    const features = await readPage(url, q, meta, state, auth);
    state.pages += 1;
    if (features.length === 0 && state.done) {
      out.finish();
      return;
    }
    const attributesOf = (f: Feature): Record<string, unknown> => (geojson ? f.properties : f.attributes) ?? {};

    const columns: Record<string, unknown[]> = {};
    for (const name of attrs) {
      const type = fieldTypes.get(name) ?? "esriFieldTypeString";
      columns[name] = features.map((f) => coerce(type, attributesOf(f)[name]));
    }
    if (wantGeometry) {
      columns[GEOMETRY] = features.map((f) => {
        const g = geojson ? f.geometry : esriToGeoJson(f.geometry);
        return g ? geojsonToWkb(g) : null;
      });
    }
    out.emit(batchFromColumns(columns, params.outputSchema));
  },

  tags: {
    ...objectTags({
      title: "Query ArcGIS Layer",
      category: "arcgis",
      keywords:
        "arcgis, esri, feature service, featureserver, mapserver, gis, geojson, rest api, layer, query, geospatial",
      docLlm:
        "Read every feature of one ArcGIS REST layer or table at `url` (ending in /FeatureServer/<id> or " +
        "/MapServer/<id>). An ArcGIS Hub / Open Data dataset page URL for one layer also works " +
        "(`https://<site>/datasets/<itemId>_<id>` or `.../datasets/<orgKey>::<slug>`); it is resolved to the " +
        "layer's REST URL first. The result columns depend on the layer: one column per attribute field, typed from " +
        "the layer metadata (object ids and integers as `INTEGER`, small integers as `SMALLINT`, doubles as " +
        "`DOUBLE`, dates as `TIMESTAMP_MS`, strings and GUIDs as `VARCHAR`). Layers with geometry add " +
        "`geometry` (`GEOMETRY`), WGS84 longitude/latitude rounded to the ATTACH `precision` (default 7 " +
        "decimals). Simple WHERE predicates are sent to the server (numeric comparisons, string equality and IN, " +
        "IS NULL, prefix/contains matches), and so are spatial filters against a constant: `geometry && <box>` " +
        "and ST_Intersects / ST_Within / ST_Contains / ST_Covers / ST_Touches / ST_Overlaps / ST_Crosses / " +
        "ST_Equals(geometry, <constant geometry>) make the server return only features whose envelope meets the " +
        "constant's. Every predicate is also applied exactly to the returned rows. Results are paged " +
        "automatically. Filter large layers on an attribute (e.g. a FIPS code) or an area: an unfiltered scan " +
        "downloads the whole layer.",
      docMd:
        "## arcgis_query(url)\n\n" +
        "Every feature of one ArcGIS FeatureServer/MapServer layer or table, paged automatically.\n\n" +
        "- `url` is a layer URL (`.../FeatureServer/0`) or an ArcGIS Hub dataset page for one layer " +
        "(`https://<site>/datasets/<itemId>_0`).\n" +
        "- Attribute fields become typed columns; the set of columns depends on the layer.\n" +
        "- Layers with geometry add `geometry` (`GEOMETRY`, WGS84 longitude/latitude).\n" +
        "- Simple attribute filters and spatial filters against a constant (`&&`, `ST_Intersects`, `ST_Within`, " +
        "...) run on the ArcGIS server, so filter large layers on an attribute or an area.",
    }),
    "vgi.result_dynamic_columns_md":
      "The columns follow the layer at `url`: one column per attribute field, in server order, typed from " +
      "its ArcGIS field type (object ids and integers `INTEGER`, small integers `SMALLINT`, big integers " +
      "`BIGINT`, doubles `DOUBLE`, singles `FLOAT`, dates `TIMESTAMP_MS`, strings and GUIDs `VARCHAR`), " +
      "with the field alias as the column comment. Layers with geometry add one fixed column:\n\n" +
      "| Name | Type | Description |\n" +
      "| --- | --- | --- |\n" +
      "| geometry | GEOMETRY | Feature geometry in WGS84 longitude/latitude, rounded to the ATTACH " +
      "`precision`. Spatial filters against a constant run on the server. |",
  },
  examples: [
    {
      sql:
        "SELECT LOCALITY, count(*) AS parcels FROM arcgis.main.arcgis_query(" +
        "'https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Parcels/FeatureServer/0') " +
        "WHERE FIPS = '51580' GROUP BY ALL",
      description: "Count the parcels in Covington, Virginia (FIPS 51580); the filter runs on the ArcGIS server",
    },
    {
      sql:
        "SELECT NAMELSAD, ST_Area_Spheroid(geometry) / 1e6 AS km2 " +
        "FROM arcgis.main.arcgis_query(" +
        "'https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Admin_Boundaries/FeatureServer/1') " +
        "WHERE NAME IN ('Covington', 'Buena Vista') ORDER BY NAMELSAD",
      description: "Areas of two Virginia cities with DuckDB spatial",
    },
    {
      sql:
        "SELECT LandmkName, City FROM arcgis.main.arcgis_query(" +
        "'https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Landmarks/FeatureServer/1') " +
        "WHERE PlaceType = 'Hospital Points' AND City LIKE 'Rich%' ORDER BY LandmkName",
      description: "Hospitals in Virginia cities whose names start with 'Rich', from the statewide landmarks layer",
    },
    {
      sql:
        "SELECT count(*) AS parcels FROM arcgis.main.arcgis_query(" +
        "'https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Parcels/FeatureServer/0') " +
        "WHERE ST_Intersects(geometry, ST_MakeEnvelope(-80.005, 37.785, -79.99, 37.795))",
      description:
        "Parcels touching a small box in downtown Covington; the server returns only features near the box, " +
        "not the state's millions of parcels",
    },
  ],
});
