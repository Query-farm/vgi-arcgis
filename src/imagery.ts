/** Batched numeric/multiband pixel sampling from ArcGIS ImageServer services. */
import { batchFromColumns, defineTableFunction, float64, int32, int64, schema, utf8 } from "@query-farm/vgi";
import { resolveAuth, secretLookup } from "./auth.ts";
import { normalizeUrl } from "./esri.ts";
import { ArcgisError, getJson } from "./http.ts";
import { column, objectTags, resultColumns } from "./meta.ts";

export function imageServiceUrl(raw: string): string {
  if (typeof raw !== "string") throw new Error("url must not be NULL");
  const url = normalizeUrl(raw);
  if (!/^https?:\/\//i.test(url) || !/\/ImageServer$/i.test(new URL(url).pathname))
    throw new Error("arcgis_sample needs an HTTP(S) URL ending in /ImageServer");
  return url;
}

export function samplePoints(raw: string): [number, number][] {
  if (typeof raw !== "string") throw new Error("points_json must not be NULL");
  let points: unknown;
  try {
    points = JSON.parse(raw);
  } catch {
    throw new Error("points_json must be a JSON array of [longitude, latitude] pairs");
  }
  if (
    !Array.isArray(points) ||
    points.length > 10_000 ||
    points.some(
      (p) =>
        !Array.isArray(p) ||
        p.length !== 2 ||
        typeof p[0] !== "number" ||
        typeof p[1] !== "number" ||
        !Number.isFinite(p[0]) ||
        !Number.isFinite(p[1]) ||
        p[0] < -180 ||
        p[0] > 180 ||
        p[1] < -90 ||
        p[1] > 90,
    )
  ) {
    throw new Error("points_json must contain at most 10000 WGS84 [longitude, latitude] pairs within valid bounds");
  }
  return points as [number, number][];
}

const outputSchema = schema([
  column("point_index", int32, "Zero-based index in points_json, if the server supplies locationId; otherwise NULL."),
  column("sample_x", float64(), "Sample location x coordinate as reported by the service."),
  column("sample_y", float64(), "Sample location y coordinate as reported by the service."),
  column("spatial_reference", utf8(), "Sample location's spatial reference as JSON; NULL if omitted by the service."),
  column(
    "value",
    utf8(),
    "Raw pixel value text, preserving multiband values and NoData; TRY_CAST(value AS DOUBLE) reads single-band numeric values.",
  ),
  column("raster_id", int64(), "Source raster object ID, or NULL when omitted."),
  column(
    "resolution",
    float64(),
    "Spatial resolution of the source raster, in its coordinate system's units, or NULL when omitted.",
  ),
]);

interface Sample {
  location?: { x?: number; y?: number; spatialReference?: unknown };
  locationId?: number;
  value?: unknown;
  rasterId?: number;
  resolution?: number;
}

export const arcgisSample = defineTableFunction<{ url: string; points_json: string }, { offset: number }>({
  name: "arcgis_sample",
  description: "Sample elevation or multiband pixel values from an ArcGIS ImageServer at WGS84 points",
  args: { url: utf8(), points_json: utf8() },
  argDocs: {
    url: "HTTP(S) ImageServer URL; query strings are ignored. Uses scoped arcgis credentials. NULL is rejected.",
    points_json:
      "JSON array of up to 10000 [longitude, latitude] pairs in WGS84, sampled in requests of 100. Empty array returns no rows. NULL and invalid coordinates are rejected.",
  },
  onBind: (params) => {
    imageServiceUrl(params.args.url);
    samplePoints(params.args.points_json);
    return {
      outputSchema,
      ...secretLookup(params.bindCall.attach_opaque_data, params.args.url, params.resolvedSecretsProvided),
    };
  },
  initialState: () => ({ offset: 0 }),
  process: async (params, state, out) => {
    const points = samplePoints(params.args.points_json);
    if (state.offset >= points.length) {
      out.finish();
      return;
    }
    const url = imageServiceUrl(params.args.url);
    const auth = resolveAuth(params.initCall.bind_call.attach_opaque_data, params.secrets, params.args.url);
    const chunk = points.slice(state.offset, state.offset + 100);
    const q = new URLSearchParams({
      f: "json",
      geometryType: "esriGeometryMultipoint",
      geometry: JSON.stringify({ points: chunk, spatialReference: { wkid: 4326 } }),
      returnFirstValueOnly: "true",
    });
    const body = (await getJson(`${url}/getSamples?${q}`, auth)) as {
      samples?: Sample[];
      exceededTransferLimit?: boolean;
    };
    if (!Array.isArray(body.samples) || body.exceededTransferLimit)
      throw new ArcgisError(`${url}: missing or truncated image samples`);
    const start = state.offset;
    state.offset += chunk.length;
    const samples = body.samples;
    const indices = new Set<number>();
    for (const s of samples) {
      if (
        s.locationId != null &&
        (!Number.isInteger(s.locationId) ||
          s.locationId < 0 ||
          s.locationId >= chunk.length ||
          indices.has(s.locationId))
      )
        throw new ArcgisError(`${url}: invalid or duplicate sample locationId`);
      if (s.locationId != null) indices.add(s.locationId);
      if (s.rasterId != null && !Number.isSafeInteger(s.rasterId)) throw new ArcgisError(`${url}: unsafe raster ID`);
    }
    if (!samples.length && state.offset >= points.length) {
      out.finish();
      return;
    }
    out.emit(
      batchFromColumns(
        {
          point_index: samples.map((s) => (s.locationId == null ? null : start + s.locationId)),
          sample_x: samples.map((s) => s.location?.x ?? null),
          sample_y: samples.map((s) => s.location?.y ?? null),
          spatial_reference: samples.map((s) =>
            s.location?.spatialReference == null ? null : JSON.stringify(s.location.spatialReference),
          ),
          value: samples.map((s) => (s.value == null ? null : String(s.value))),
          raster_id: samples.map((s) => (s.rasterId == null ? null : BigInt(s.rasterId))),
          resolution: samples.map((s) => s.resolution ?? null),
        },
        params.outputSchema,
      ),
    );
  },
  tags: {
    "vgi.result_columns_schema": resultColumns(outputSchema, [
      "INTEGER",
      "DOUBLE",
      "DOUBLE",
      "VARCHAR",
      "VARCHAR",
      "BIGINT",
      "DOUBLE",
    ]),
    ...objectTags({
      title: "ImageServer Pixel Sampling",
      category: "arcgis",
      keywords: "imagery, imageserver, raster, pixels, elevation, usgs, 3dep, sampling",
      docLlm:
        "Read pixel values from an ArcGIS ImageServer using getSamples. Required url and points_json, a JSON array of WGS84 [longitude,latitude] pairs (maximum 10000; empty gives no rows; NULL/invalid coordinates rejected). Makes batched requests of 100 points, not one RPC per row. Returns point_index (zero-based input index when locationId is supplied, else NULL), sample_x, sample_y, spatial_reference JSON text, value text, raster_id `BIGINT`, resolution `DOUBLE`. Raw value text preserves multiband and NoData values; TRY_CAST to `DOUBLE` for elevation. Uses the service's default mosaic/pixel size and first non-NoData value. Points outside coverage may produce no row. No raster downloads, image export or catalog views. Scoped arcgis credentials work as for arcgis_query.",
      docMd:
        "## Image sampling\n\nSample raster pixels at WGS84 points using `arcgis_sample(url, points_json)`. Requests contain up to 100 points each, with a maximum input of 10000. Empty input gives no rows; NULL/invalid input fails. Returns sample coordinates and spatial-reference JSON, raw pixel `value`, source raster ID and resolution. `point_index` refers to the input array when the service returns `locationId`, otherwise NULL. Multiband and NoData values remain text; use `TRY_CAST(value AS DOUBLE)` for elevation. Uncovered points may have no row. Uses the default mosaic and first non-NoData value. This samples pixels; it does not download raster files.",
    }),
  },
  examples: [
    {
      sql: "SELECT point_index, TRY_CAST(value AS DOUBLE) AS elevation_m FROM arcgis.main.arcgis_sample('https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer', '[[-77.0365,38.8977],[-77.04,38.90]]') ORDER BY point_index",
      description: "Sample USGS bare-earth elevation in meters near the White House",
    },
  ],
});
