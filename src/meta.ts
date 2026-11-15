/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 *
 * - Catalog-level tags (title, license, author, links, long description) live in
 *   `CATALOG_TAGS` below.
 * - Every function carries `objectTags(...)`: a title, a category from
 *   `SCHEMA_CATEGORIES`, search keywords, and LLM- and human-facing docs.
 */

import { field, type VgiDataType, type VgiField, type VgiSchema } from "@query-farm/vgi";

export const CATALOG_NAME = "arcgis";
export const VERSION = "0.6.1";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-arcgis";

/**
 * Categories group functions in docs and agent tools. Every object's
 * `vgi.category` must name one of these.
 */
export const SCHEMA_CATEGORIES = [
  {
    name: "arcgis",
    title: "ArcGIS REST",
    description: "ArcGIS feature queries and summaries, and ImageServer pixel sampling.",
  },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

/** Static result metadata reuses the Arrow fields' descriptions. */
export function resultColumns(output: VgiSchema, types: string[]): string {
  return JSON.stringify(
    output.fields.map((f, i) => ({ name: f.name, type: types[i], description: f.metadata?.get("comment") ?? "" })),
  );
}

/** The ArcGIS REST API reference pages for every endpoint the worker calls (each checked live). */
const REST_DOCS = {
  featureQuery: "https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-layer/",
  mapQuery: "https://developers.arcgis.com/rest/services-reference/enterprise/query-map-service-layer/",
  getSamples: "https://developers.arcgis.com/rest/services-reference/enterprise/get-samples/",
  catalog: "https://developers.arcgis.com/rest/services-reference/enterprise/catalog/",
  generateToken: "https://developers.arcgis.com/rest/services-reference/enterprise/generate-token/",
  oauthToken: "https://developers.arcgis.com/rest/users-groups-and-items/token/",
  security: "https://developers.arcgis.com/documentation/security-and-authentication/",
  hubApi: "https://hub.arcgis.com/api/v3/",
} as const;

/** The catalog comment: one plain paragraph for directories (VGI107). The long guide is in doc_md/doc_llm. */
export const CATALOG_COMMENT =
  "Live ArcGIS FeatureServer, MapServer and ImageServer data from any service URL as SQL: layers as views " +
  "with GEOMETRY, server-side counts and statistics, and raster pixel sampling. Public services need no key; " +
  "secured ones take ArcGIS tokens or OAuth app credentials.";

/** The `main` schema comment: one plain sentence. */
export const SCHEMA_COMMENT =
  "Functions that read, count, summarize and sample any ArcGIS layer or ImageServer by URL, plus views over the attached service's layers.";

const SOURCES_MD =
  "## Sources\n\n" +
  "Every query goes live to the ArcGIS server named by the URL you supply, through the public ArcGIS REST API:\n\n" +
  `- Feature scans, counts and statistics use [Query (Feature Service/Layer)](${REST_DOCS.featureQuery}) and ` +
  `[Query (Map Service/Layer)](${REST_DOCS.mapQuery}).\n` +
  `- Services directories are walked through the [Services Directory root](${REST_DOCS.catalog}).\n` +
  `- Imagery sampling uses [Get Samples](${REST_DOCS.getSamples}) on an ImageServer.\n` +
  `- ArcGIS Hub sites and dataset pages are resolved through the [Hub API](${REST_DOCS.hubApi}).\n` +
  `- Secured services: [Generate Token](${REST_DOCS.generateToken}), the portal [/token](${REST_DOCS.oauthToken}) ` +
  `OAuth endpoint, and Esri's [security and authentication guide](${REST_DOCS.security}).`;

const SOURCES_LLM =
  "Endpoints called, with their reference pages: layer /query (" +
  REST_DOCS.featureQuery +
  ", " +
  REST_DOCS.mapQuery +
  "), services directory root (" +
  REST_DOCS.catalog +
  "), ImageServer /getSamples (" +
  REST_DOCS.getSamples +
  "), Hub API (" +
  REST_DOCS.hubApi +
  "), generateToken (" +
  REST_DOCS.generateToken +
  ") and portal OAuth /token (" +
  REST_DOCS.oauthToken +
  ").";

export const CATALOG_DOC_LLM =
  "Query live ArcGIS services (FeatureServer and MapServer layers and tables, and ImageServer rasters, published " +
  "through ArcGIS Server, ArcGIS Enterprise, ArcGIS Online or ArcGIS Hub) from DuckDB SQL, for any user-supplied " +
  "URL worldwide; the worker has no built-in list of agencies. Two ways in. (1) Call a function with a layer or " +
  "ImageServer URL and no ATTACH url: read features, count or summarize them on the server without " +
  "downloading them, or sample pixel values at WGS84 points. (2) Attach with " +
  "a `url` option to browse: a services directory URL gives one schema per service and one view per layer, a " +
  "service URL gives one view per layer in `main`, a layer URL gives one view. An ArcGIS Hub / Open Data site " +
  "URL (e.g. `https://gis.data.ca.gov`) works like a services directory, one schema per service named after " +
  "the item title; a Hub dataset page URL (`https://<site>/datasets/<itemId>_<n>`, `.../datasets/<itemId>` or " +
  "`.../datasets/<orgKey>::<slug>`) resolves to the REST layer behind it, in ATTACH and in every function. " +
  "Attribute fields become typed columns and geometry a WGS84 `geometry` GEOMETRY column; the `precision` " +
  "ATTACH option (default 7) sets coordinate decimals. Simple WHERE predicates and spatial filters against a " +
  "constant (`geometry && <box>`, ST_Intersects, ST_Within, ...) run on the server and are re-applied exactly " +
  "in the worker; results page automatically and are read live on every query (only layer metadata is cached). " +
  "For large layers prefer the server-side count and statistics functions over aggregating a full scan. " +
  "Secured services: the secret ATTACH options `token`, `username` + `password`, or `client_id` + " +
  "`client_secret` (an ArcGIS OAuth app) apply only to the ATTACH `url`'s server and also list its secured " +
  "services as views. Or create a DuckDB secret of type `arcgis` (TOKEN, or USERNAME and PASSWORD, or " +
  "CLIENT_ID and CLIENT_SECRET, plus a SCOPE URL prefix), which the functions use for URLs under the scope but " +
  "which catalog listings cannot see: CREATE SECRET gis (TYPE arcgis, TOKEN getenv('ARCGIS_TOKEN'), SCOPE " +
  "'https://gis.example.gov/arcgis/rest/services/'). ATTACH credentials win over a secret; generated tokens " +
  "renew automatically. HTTP errors 498/499 mean a missing, invalid or expired token. " +
  SOURCES_LLM;

export const CATALOG_DOC_MD =
  "# ArcGIS REST services in DuckDB\n\n" +
  "Government agencies, utilities and organizations worldwide publish their GIS data as ArcGIS REST services. " +
  "This worker reads them live, from whatever service URL you give it: there is no built-in list of agencies, " +
  "and no data is copied or cached apart from layer metadata.\n\n" +
  "## Two ways in\n\n" +
  "Call a function with a layer URL when you already know the layer. The functions read features, count or " +
  "summarize them on the server (so a ten-million-parcel layer is never downloaded to answer a count), or " +
  "sample ImageServer pixel values such as elevation at a batch of points.\n\n" +
  "Attach with a `url` option when you want to browse. A services directory (`.../arcgis/rest/services`) " +
  "becomes one schema per service with one view per layer; a single service (`.../FeatureServer`) becomes one " +
  "view per layer in `main`; a layer (`.../FeatureServer/0`) becomes one view. An ArcGIS Hub or Open Data site " +
  "(such as `https://gis.data.ca.gov`) works like a services directory, and a Hub dataset page " +
  "(`.../datasets/<itemId>_0`) resolves to the REST layer behind it.\n\n" +
  "```sql\n" +
  "ATTACH 'arcgis' AS va (TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-arcgis@v" +
  VERSION +
  "',\n" +
  "  url 'https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Admin_Boundaries/FeatureServer');\n" +
  "SHOW ALL TABLES;\n" +
  "```\n\n" +
  "## Geometry and filters\n\n" +
  "Attribute fields arrive as typed columns and feature geometry as a WGS84 `GEOMETRY` column, rounded to " +
  "`precision` decimals (default 7, about 1 cm). Simple filters (numeric comparisons, string equality and " +
  "`IN`, `IS NULL`, prefix matches) and spatial filters against a constant (`geometry && <box>`, " +
  "`ST_Intersects`, `ST_Within`, ...) are sent to the ArcGIS server, and every filter is also applied exactly " +
  "in the worker, so results never depend on how much the server understood. Pages are fetched automatically.\n\n" +
  "## Secured services\n\n" +
  "Public services need no credentials. For token-secured ones, either ATTACH with the secret options " +
  "`token`, `username` + `password`, or `client_id` + `client_secret` (redacted from `duckdb_databases()` and " +
  "sent only to the ATTACH `url`'s server), or create an `arcgis` secret scoped to a URL prefix for the " +
  "functions. Generated tokens are renewed automatically; `getenv()` keeps a credential out of the SQL text:\n\n" +
  "```sql\nCREATE SECRET gis_token (TYPE arcgis, TOKEN getenv('ARCGIS_TOKEN'),\n" +
  "  SCOPE 'https://gis.example.gov/arcgis/rest/services/');\n```\n\n" +
  SOURCES_MD;

export const SCHEMA_DOC_LLM =
  "The `main` schema holds the URL-driven functions (reading features, server-side counts and grouped " +
  "statistics, ImageServer pixel sampling) and, when the catalog " +
  "was attached with a service or layer `url`, one view per layer. A services directory or Hub site `url` " +
  "adds one schema per service instead. For a token-secured URL the functions use the catalog's ATTACH " +
  "credentials when they cover the URL's server, else the `arcgis` secret whose SCOPE is the longest prefix " +
  "of the URL. Filters in ArcGIS SQL (where_clause) and bbox arguments run on the server.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "The entry point of the ArcGIS worker. Its functions take an ArcGIS layer or ImageServer URL directly, so " +
  "nothing needs to be attached first; when the catalog was attached with a service or layer `url`, `main` " +
  "also lists one view per layer of it. Attaching a services directory or ArcGIS Hub site instead adds one " +
  "schema per service alongside `main`.\n\n" +
  "For a token-secured URL, the functions use the catalog's ATTACH credentials when they cover the URL's " +
  "server, and otherwise the `arcgis` secret whose `SCOPE` is the longest prefix of the URL. Catalog views " +
  "see only ATTACH credentials.";

export const AGENT_TEST_TASKS = [
  {
    name: "server_count",
    prompt:
      "Count New York counties at https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1 using a server-side count without downloading features. New York's STATE FIPS is 36.",
  },
  {
    name: "server_statistics",
    prompt:
      "Using https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1, count non-null OBJECTID values grouped by STATE for New York (36), computing the statistic on the server. Return exactly the columns group_value and statistic_value, ordered by group_value.",
  },
  {
    name: "imagery_sampling",
    prompt:
      "Sample elevation in meters at longitude -77.0365, latitude 38.8977 from " +
      "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer using the imagery function. " +
      "Save the answer as a temporary table white_house_elevation with one DOUBLE column elevation_m.",
  },
  {
    name: "covington_parcels",
    prompt:
      "Using the arcgis worker, how many parcels does the Virginia statewide parcel layer " +
      "(https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Parcels/FeatureServer/0) " +
      "have in Covington City (FIPS 51580)? Save the answer as a temporary table covington_parcels " +
      "with one BIGINT column parcels.",
  },
  {
    name: "densest_virginia_city",
    prompt:
      "Which Virginia independent city has the most land parcels per square mile? Count parcels per FIPS code " +
      "on the server from the statewide parcel layer " +
      "(https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Parcels/FeatureServer/0, field FIPS) " +
      "and divide by each city's AREASQMI from the cities and counties layer " +
      "(https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Admin_Boundaries/FeatureServer/1, " +
      "where cities have JURISTYPE 'CI' and STCOFIPS is the FIPS code). Save the answer as a temporary table " +
      "densest_city with one row and one VARCHAR column name holding the city's NAME.",
  },
  {
    name: "largest_of_two_cities",
    prompt:
      "Using the cities and counties layer at " +
      "https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Admin_Boundaries/FeatureServer/1, " +
      "which is larger by area: Covington or Buena Vista? Return only the winning city's NAME column.",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "ArcGIS REST Feature Services",
  "vgi.subtitle": "Live ArcGIS feature queries, server summaries and raster sampling from service URLs worldwide.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query.Farm",
  "vgi.copyright": "Copyright 2026 Query.Farm LLC",
  "vgi.keywords": keywordsArray(
    "vgi, duckdb, arcgis, esri, feature service, featureserver, mapserver, gis, geojson, open data, hub",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
  "vgi.executable_examples": JSON.stringify([
    {
      description: "Empty point input returns no samples without contacting a service",
      sql: "SELECT count(*) AS sample_count FROM arcgis.main.arcgis_sample('https://example.org/arcgis/rest/services/Elevation/ImageServer', '[]') ORDER BY sample_count",
      expected_result: [[0]],
    },
  ]),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "ArcGIS Functions",
  domain: "geospatial",
  "vgi.keywords": keywordsArray("arcgis, feature layer, query, geojson, gis"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};
