/** Explicit ArcGIS summaries: remote SQL semantics, without a feature download. */
import { batchFromColumns, defineTableFunction, float64, int64, schema, utf8 } from "@query-farm/vgi";
import { resolveAuth, secretLookup } from "./auth.ts";
import { ArcgisError, getJson } from "./http.ts";
import { column, objectTags, resultColumns } from "./meta.ts";
import { layerMeta } from "./query.ts";

interface SummaryArgs {
  url: string;
  where_clause: string;
  bbox: string;
}
interface StatisticsArgs extends SummaryArgs {
  statistic_field: string;
  statistic: string;
  group_by: string;
}
const args = { url: utf8(), where_clause: utf8(), bbox: utf8() };
const argDefaults = { where_clause: "1=1", bbox: "" };
const argDocs = {
  url: "ArcGIS FeatureServer/MapServer layer or Hub dataset URL; NULL is rejected. Uses scoped arcgis credentials.",
  where_clause:
    "ArcGIS SQL WHERE expression evaluated by the server, with its collation and null semantics. Default 1=1; NULL uses that default. Blank is rejected.",
  bbox: "Optional WGS84 xmin,ymin,xmax,ymax bounding box; server uses geometry intersects. Empty or NULL disables it. Invalid bounds and antimeridian-crossing boxes are rejected.",
};

export function summaryQuery(args: SummaryArgs): URLSearchParams {
  if (typeof args.url !== "string" || !args.url) throw new Error("url must not be NULL or empty");
  if (typeof args.where_clause !== "string" || !args.where_clause.trim())
    throw new Error("where_clause must not be NULL or empty");
  if (typeof args.bbox !== "string") throw new Error("bbox must not be NULL");
  const query = new URLSearchParams({ f: "json", where: args.where_clause, returnGeometry: "false" });
  if (args.bbox) {
    const parts = args.bbox.split(",");
    const [xmin, ymin, xmax, ymax] = parts.map(Number);
    if (
      parts.length !== 4 ||
      parts.some((s) => !s.trim()) ||
      ![xmin, ymin, xmax, ymax].every((n) => Number.isFinite(n)) ||
      xmin === undefined ||
      ymin === undefined ||
      xmax === undefined ||
      ymax === undefined ||
      xmin < -180 ||
      xmax > 180 ||
      ymin < -90 ||
      ymax > 90 ||
      xmin > xmax ||
      ymin > ymax
    ) {
      throw new Error("bbox must be WGS84 xmin,ymin,xmax,ymax with ordered bounds inside [-180,180] and [-90,90]");
    }
    query.set("geometry", [xmin, ymin, xmax, ymax].join(","));
    query.set("geometryType", "esriGeometryEnvelope");
    query.set("inSR", "4326");
    query.set("spatialRel", "esriSpatialRelIntersects");
  }
  return query;
}

const countSchema = schema([
  column(
    "feature_count",
    int64(),
    "Number of matching features reported by the ArcGIS server; 0 for no matches.",
    false,
  ),
]);
export const arcgisCount = defineTableFunction<SummaryArgs, { done: boolean }>({
  name: "arcgis_count",
  description: "Count matching ArcGIS features on the server without downloading them",
  args,
  argDefaults,
  argDocs,
  onBind: (params) => {
    summaryQuery(params.args);
    return {
      outputSchema: countSchema,
      ...secretLookup(params.bindCall.attach_opaque_data, params.args.url, params.resolvedSecretsProvided),
    };
  },
  initialState: () => ({ done: false }),
  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    const auth = resolveAuth(params.initCall.bind_call.attach_opaque_data, params.secrets, params.args.url);
    const { url } = await layerMeta(params.args.url, auth);
    const q = summaryQuery(params.args);
    q.set("returnCountOnly", "true");
    const body = (await getJson(`${url}/query?${q}`, auth)) as { count?: number };
    if (!Number.isSafeInteger(body.count) || (body.count as number) < 0)
      throw new ArcgisError(`${url}: missing or unsafe integer count`);
    state.done = true;
    out.emit(batchFromColumns({ feature_count: [BigInt(body.count as number)] }, params.outputSchema));
  },
  tags: {
    "vgi.result_columns_schema": resultColumns(countSchema, ["BIGINT"]),
    ...objectTags({
      title: "Server-side Feature Count",
      category: "arcgis",
      keywords: "count, summary, aggregate, arcgis",
      docLlm:
        "Count one ArcGIS layer via returnCountOnly=true, without transferring features. Required url; optional where_clause (ArcGIS SQL, default 1=1) and bbox (WGS84 xmin,ymin,xmax,ymax, default empty). Uses scoped arcgis credentials. Returns one feature_count `BIGINT`, including zero. NULL url is rejected; NULL optional arguments use their defaults. Remote comparison/collation and spatial semantics apply; this is not automatic pushdown of DuckDB COUNT(*) or its WHERE clauses. Apply restrictions using the named arguments. Unsafe or missing counts raise an error.",
      docMd:
        "## ArcGIS count\n\nReturns one `feature_count BIGINT` using the server's `returnCountOnly` operation. Restrict rows with `where_clause` (ArcGIS SQL) and `bbox` (WGS84 xmin,ymin,xmax,ymax). Uses the same credentials as `arcgis_query`. No feature download. Zero matches return 0; NULL url is rejected; NULL optional arguments use their defaults. Outer SQL filters apply to the summary, so use the named arguments to filter source records.",
    }),
  },
  examples: [
    {
      sql: "SELECT feature_count FROM arcgis.main.arcgis_count('https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1', where_clause := 'STATE = ''36''')",
      description: "Count New York counties on Census TIGERweb",
    },
  ],
});

const statisticsSchema = schema([
  column("group_value", utf8(), "Group field value as text; NULL for an ungrouped aggregate or a null-valued group."),
  column(
    "statistic_value",
    float64(),
    "Server aggregate as `DOUBLE`, possibly NULL for no non-null values. Large integers may lose precision; use arcgis_count for exact total counts.",
  ),
]);
export const arcgisStatistics = defineTableFunction<StatisticsArgs, { done: boolean }>({
  name: "arcgis_statistics",
  description: "Compute a numeric statistic, optionally grouped by one field, on an ArcGIS server",
  args: {
    url: utf8(),
    statistic_field: utf8(),
    statistic: utf8(),
    group_by: utf8(),
    where_clause: utf8(),
    bbox: utf8(),
  },
  argDefaults: { ...argDefaults, statistic: "sum", group_by: "" },
  argDocs: {
    ...argDocs,
    statistic_field:
      "Exact numeric layer field name (any attribute field for count); expressions and NULL are rejected.",
    statistic: "Server statistic: count, sum, min, max, avg, stddev or var. Default sum.",
    group_by: "Optional single exact attribute field name to group by. Empty or NULL returns one ungrouped statistic.",
  },
  argConstraints: { statistic: { choices: ["count", "sum", "min", "max", "avg", "stddev", "var"] } },
  onBind: (params) => {
    summaryQuery(params.args);
    if (
      typeof params.args.statistic_field !== "string" ||
      !params.args.statistic_field ||
      typeof params.args.group_by !== "string"
    )
      throw new Error("statistic_field and group_by must not be NULL; statistic_field must not be empty");
    return {
      outputSchema: statisticsSchema,
      ...secretLookup(params.bindCall.attach_opaque_data, params.args.url, params.resolvedSecretsProvided),
    };
  },
  initialState: () => ({ done: false }),
  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    const auth = resolveAuth(params.initCall.bind_call.attach_opaque_data, params.secrets, params.args.url);
    const { url, meta } = await layerMeta(params.args.url, auth);
    const { statistic_field, statistic, group_by } = params.args;
    const field = meta.fields?.find((f) => f.name === statistic_field);
    if (
      !field ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(statistic_field) ||
      (statistic !== "count" && !/^esriFieldType(OID|Integer|SmallInteger|BigInteger|Single|Double)$/.test(field.type))
    )
      throw new Error("statistic_field must name a numeric attribute (or any attribute for count)");
    if (group_by && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(group_by) || !meta.fields?.some((f) => f.name === group_by)))
      throw new Error("group_by must name one attribute field");
    const q = summaryQuery(params.args);
    q.set(
      "outStatistics",
      JSON.stringify([
        { statisticType: statistic, onStatisticField: statistic_field, outStatisticFieldName: "vgi_statistic" },
      ]),
    );
    if (group_by) q.set("groupByFieldsForStatistics", group_by);
    const body = (await getJson(`${url}/query?${q}`, auth)) as {
      features?: { attributes: Record<string, unknown> }[];
      exceededTransferLimit?: boolean;
    };
    if (!Array.isArray(body.features) || body.exceededTransferLimit)
      throw new ArcgisError(`${url}: missing or truncated statistics; narrow where_clause or bbox`);
    state.done = true;
    if (!body.features.length) {
      out.finish();
      return;
    }
    const values = body.features.map((f) => {
      if (!f.attributes || !("vgi_statistic" in f.attributes)) throw new ArcgisError(`${url}: missing statistic value`);
      const value = f.attributes.vgi_statistic;
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value)))
        throw new ArcgisError(`${url}: invalid numeric statistic`);
      return value;
    });
    out.emit(
      batchFromColumns(
        {
          group_value: body.features.map((f) =>
            !group_by || f.attributes[group_by] == null ? null : String(f.attributes[group_by]),
          ),
          statistic_value: values,
        },
        params.outputSchema,
      ),
    );
  },
  tags: {
    "vgi.result_columns_schema": resultColumns(statisticsSchema, ["VARCHAR", "DOUBLE"]),
    ...objectTags({
      title: "Server-side Layer Statistics",
      category: "arcgis",
      keywords: "statistics, sum, average, group, aggregate, arcgis",
      docLlm:
        "Aggregate a layer using ArcGIS outStatistics. Required url and statistic_field; optional statistic (sum by default; count/min/max/avg/stddev/var also supported), group_by (one field, default empty), where_clause (ArcGIS SQL, default 1=1) and bbox (WGS84 bounds, default empty). Scoped arcgis credentials apply. Returns group_value `VARCHAR` and statistic_value `DOUBLE`; null groups and null aggregate values remain NULL. Without group_by, group_value is NULL. Empty grouped results have no rows. NULL required inputs are rejected; NULL optional arguments use their defaults. Numeric statistics need a numeric field; count counts non-null field values. Large integer aggregates may lose `DOUBLE` precision. A truncated server result raises an error; narrow the source filters. This is an explicit server operation, not automatic DuckDB GROUP BY pushdown.",
      docMd:
        "## ArcGIS statistics\n\nCompute `statistic` over `statistic_field`, optionally grouped by `group_by`. Filter source rows using ArcGIS SQL `where_clause` or WGS84 `bbox`. Returns `group_value VARCHAR` and `statistic_value DOUBLE`, retaining NULL values. Defaults: sum, no grouping, all rows. NULL required inputs are rejected; NULL optional arguments use their defaults. Count counts non-null field values. Truncated responses fail rather than return partial groups; narrow the source filter. `DOUBLE` can round large integer aggregates; `arcgis_count` provides exact total feature counts.",
    }),
  },
  examples: [
    {
      sql: "SELECT group_value AS state, statistic_value AS land_area FROM arcgis.main.arcgis_statistics('https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1', 'AREALAND', group_by := 'STATE', where_clause := 'STATE = ''36''') ORDER BY state",
      description: "Sum county land area by state on the Census server",
    },
  ],
});
