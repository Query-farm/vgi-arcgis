/**
 * `arcgis_query(url)`: stream every feature of one ArcGIS layer or table.
 *
 * - The output schema comes from the layer's `?f=json` field list.
 * - Filters DuckDB pushes down become the ArcGIS `where` clause where that
 *   is safe (see where.ts), and are re-applied exactly to every batch
 *   (`autoApplyFilters`); only the projected columns are requested.
 * - Geometry is never decoded here: ArcGIS returns GeoJSON (or, for servers
 *   without `f=geojson`, Esri JSON reshaped to GeoJSON) and the text is passed
 *   through in `geometry_geojson`, in WGS84, rounded to the ATTACH `precision`.
 *   The catalog's views turn it into GEOMETRY with `ST_GeomFromGeoJSON`.
 * - Paging is keyset on the object id when the layer supports `orderBy`,
 *   `resultOffset` when it only supports pagination, and a single request
 *   otherwise (failing loudly if the server truncates it).
 */

import { batchFromColumns, defineTableFunction, schema, utf8 } from "@query-farm/vgi";
import {
  arrowType,
  attributeFields,
  esriToGeoJson,
  GEOMETRY_GEOJSON,
  type LayerMeta,
  supportsGeoJson,
} from "./esri.ts";
import { ArcgisError, getJson, getMetadata } from "./http.ts";
import { resolveUrl } from "./hub.ts";
import { log } from "./log.ts";
import { column, objectTags } from "./meta.ts";
import { decodeSettings } from "./options.ts";
import { WhereBuilder } from "./where.ts";

interface QueryArgs {
  url: string;
}

/** Cursor. Plain numbers only: over HTTP it travels with each request. */
interface QueryState {
  /** Highest object id emitted (keyset paging); meaningful once `started`. */
  lastOid: number;
  started: boolean;
  /** Rows emitted so far (offset paging). */
  offset: number;
  /** Pages fetched so far; sizes the next one (see pageSize). */
  pages: number;
  done: boolean;
}

type PagingMode = "keyset" | "offset" | "single";

/**
 * Fetch and check a layer's metadata; an ArcGIS Hub dataset URL is resolved
 * to its layer first (cached). @throws Error if the URL is not a layer.
 */
export async function layerMeta(url: string): Promise<{ url: string; meta: LayerMeta }> {
  const target = await resolveUrl(url);
  if (target.kind !== "layer") {
    throw new Error(
      "arcgis_query needs a layer URL ending in /FeatureServer/<id> or /MapServer/<id>, or an ArcGIS Hub " +
        `dataset URL for one layer (.../datasets/<itemId>_<id>), got '${url}'` +
        (target.kind === "service" ? ` (a whole service, ${target.url})` : ""),
    );
  }
  const meta = (await getMetadata(`${target.url}?f=json`)) as LayerMeta;
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

export function pagingMode(meta: LayerMeta): PagingMode {
  if (!meta.objectIdField) return meta.advancedQueryCapabilities?.supportsPagination ? "offset" : "single";
  if (meta.advancedQueryCapabilities?.supportsOrderBy) return "keyset";
  if (meta.advancedQueryCapabilities?.supportsPagination) return "offset";
  return "single";
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

/** A feature from `/query`: GeoJSON (`properties`) or Esri JSON (`attributes`). */
interface ArcgisFeature {
  id?: number | string;
  properties?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  geometry?: unknown;
}

export const arcgisQuery = defineTableFunction<QueryArgs, QueryState>({
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
  // DuckDB drops every predicate it pushes down from its own plan, so the
  // worker must return exactly the matching rows. The ArcGIS `where` is only a
  // superset (see where.ts); the SDK re-applies all pushed predicates, with
  // DuckDB semantics, to each emitted batch.
  autoApplyFilters: true,

  onBind: async (params) => {
    const { meta } = await layerMeta(params.args.url);
    const columns = attributeFields(meta).map((f) =>
      column(f.name, arrowType(f.type) as NonNullable<ReturnType<typeof arrowType>>, f.alias || f.name),
    );
    if (meta.geometryType) {
      columns.push(
        column(
          GEOMETRY_GEOJSON,
          utf8(),
          "Feature geometry as GeoJSON text in WGS84 (EPSG:4326); parse with ST_GeomFromGeoJSON.",
        ),
      );
    }
    return { outputSchema: schema(columns) };
  },

  initialState: () => ({ lastOid: 0, started: false, offset: 0, pages: 0, done: false }),

  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    const { url, meta } = await layerMeta(params.args.url);
    const settings = decodeSettings(params.initCall.bind_call.attach_opaque_data);
    const fields = attributeFields(meta);
    const fieldTypes = new Map(fields.map((f) => [f.name, f.type]));
    const where = new WhereBuilder(fieldTypes).where(params.pushdownFilters?.filters ?? []);
    const wanted = params.outputSchema.fields.map((f) => f.name);
    const attrs = wanted.filter((n) => n !== GEOMETRY_GEOJSON);
    const wantGeometry = wanted.includes(GEOMETRY_GEOJSON);
    const oid = meta.objectIdField;
    const mode = pagingMode(meta);
    const outFields = new Set(attrs);
    if (oid) outFields.add(oid);
    const geojson = supportsGeoJson(meta);

    const q = new URLSearchParams({
      where: !(mode === "keyset" && state.started)
        ? where
        : where === "1=1"
          ? `${oid} > ${state.lastOid}`
          : `(${where}) AND ${oid} > ${state.lastOid}`,
      outFields: outFields.size ? [...outFields].join(",") : "*",
      returnGeometry: String(wantGeometry && Boolean(meta.geometryType)),
      outSR: "4326",
      f: geojson ? "geojson" : "json",
    });
    if (wantGeometry) q.set("geometryPrecision", String(settings.precision));
    if (mode === "keyset") q.set("orderByFields", `${oid} ASC`);
    const size = pageSize(meta, state.pages, wantGeometry && Boolean(meta.geometryType));
    if (mode === "offset") q.set("resultOffset", String(state.offset));
    if (size !== undefined && mode !== "single") q.set("resultRecordCount", String(size));
    if (state.offset === 0)
      log.debug(`arcgis_query ${url}: mode=${mode} where=${where} outFields=${q.get("outFields")}`);

    const body = (await getJson(`${url}/query?${q}`)) as {
      features?: ArcgisFeature[];
      exceededTransferLimit?: boolean;
      properties?: { exceededTransferLimit?: boolean };
    };
    const features = body.features ?? [];
    const exceeded = Boolean(body.exceededTransferLimit ?? body.properties?.exceededTransferLimit);
    // Every process() call must emit a batch or finish; returning with neither
    // stalls the stream (a query matching no rows would hang).
    if (features.length === 0) {
      state.done = true;
      out.finish();
      return;
    }
    const attributesOf = (f: ArcgisFeature): Record<string, unknown> => (geojson ? f.properties : f.attributes) ?? {};

    const columns: Record<string, unknown[]> = {};
    for (const name of attrs) {
      const type = fieldTypes.get(name) ?? "esriFieldTypeString";
      columns[name] = features.map((f) => coerce(type, attributesOf(f)[name]));
    }
    if (wantGeometry) {
      columns[GEOMETRY_GEOJSON] = features.map((f) => {
        const g = geojson ? f.geometry : esriToGeoJson(f.geometry);
        return g ? JSON.stringify(g) : null;
      });
    }
    out.emit(batchFromColumns(columns, params.outputSchema));

    state.offset += features.length;
    state.pages += 1;
    if (mode === "keyset" && oid) {
      for (const f of features) {
        const v = Number(attributesOf(f)[oid] ?? f.id);
        if (!state.started || v > state.lastOid) state.lastOid = v;
        state.started = true;
      }
    }
    if (!exceeded) {
      state.done = true;
    } else if (mode === "single") {
      throw new ArcgisError(
        `${url} returned only ${features.length} rows: the server truncated the result and supports neither ` +
          "orderBy nor pagination. Add a filter so fewer rows match.",
      );
    }
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
        "`geometry_geojson` (`VARCHAR`), the geometry as GeoJSON in WGS84 rounded to the ATTACH `precision` " +
        "(default 7 decimals); wrap it with ST_GeomFromGeoJSON(geometry_geojson) to get `GEOMETRY`, or use the " +
        "views the catalog creates when attached with a `url`. Simple WHERE predicates are sent to the server " +
        "(numeric comparisons, string equality and IN, IS NULL, prefix/contains matches) and every predicate is " +
        "also applied exactly to the returned rows. Results are paged automatically. Filter on an attribute " +
        "(e.g. a FIPS code) for large layers: an unfiltered scan downloads the whole layer.",
      docMd:
        "## arcgis_query(url)\n\n" +
        "Every feature of one ArcGIS FeatureServer/MapServer layer or table, paged automatically.\n\n" +
        "- `url` is a layer URL (`.../FeatureServer/0`) or an ArcGIS Hub dataset page for one layer " +
        "(`https://<site>/datasets/<itemId>_0`).\n" +
        "- Attribute fields become typed columns; the set of columns depends on the layer.\n" +
        "- Geometry arrives as `geometry_geojson` text in WGS84; `ST_GeomFromGeoJSON` turns it into `GEOMETRY`.\n" +
        "- Simple filters run on the ArcGIS server, so filter large layers on an attribute such as a FIPS code.",
    }),
    "vgi.result_dynamic_columns_md":
      "The columns follow the layer at `url`: one column per attribute field, in server order, typed from " +
      "its ArcGIS field type (object ids and integers `INTEGER`, small integers `SMALLINT`, big integers " +
      "`BIGINT`, doubles `DOUBLE`, singles `FLOAT`, dates `TIMESTAMP_MS`, strings and GUIDs `VARCHAR`), " +
      "with the field alias as the column comment. Layers with geometry add one fixed column:\n\n" +
      "| Name | Type | Description |\n" +
      "| --- | --- | --- |\n" +
      "| geometry_geojson | VARCHAR | Geometry as GeoJSON in WGS84, rounded to the ATTACH `precision`; " +
      "parse with `ST_GeomFromGeoJSON`. |",
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
        "SELECT NAMELSAD, ST_Area_Spheroid(ST_GeomFromGeoJSON(geometry_geojson)) / 1e6 AS km2 " +
        "FROM arcgis.main.arcgis_query(" +
        "'https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Admin_Boundaries/FeatureServer/1') " +
        "WHERE NAME IN ('Covington', 'Buena Vista') ORDER BY NAMELSAD",
      description: "Areas of two Virginia cities, parsing the GeoJSON geometry with DuckDB spatial",
    },
    {
      sql:
        "SELECT LandmkName, City FROM arcgis.main.arcgis_query(" +
        "'https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Landmarks/FeatureServer/1') " +
        "WHERE PlaceType = 'Hospital Points' AND City LIKE 'Rich%' ORDER BY LandmkName",
      description: "Hospitals in Virginia cities whose names start with 'Rich', from the statewide landmarks layer",
    },
  ],
});
