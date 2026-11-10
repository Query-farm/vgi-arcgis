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

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "arcgis";
export const VERSION = "0.3.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-arcgis";

/**
 * Categories group functions in docs and agent tools. Every object's
 * `vgi.category` must name one of these.
 */
export const SCHEMA_CATEGORIES = [
  {
    name: "arcgis",
    title: "ArcGIS REST",
    description: "Table functions that read ArcGIS FeatureServer and MapServer layers.",
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

export const CATALOG_DOC_LLM =
  "Query ArcGIS REST feature services (FeatureServer and MapServer layers, as published by state and " +
  "local governments through ArcGIS Server, ArcGIS Online and ArcGIS Hub) from DuckDB SQL. " +
  "`main.arcgis_query(url)` reads one layer or table: attribute fields become typed columns and geometry " +
  "becomes a `geometry` GEOMETRY column (WGS84). Attach with a `url` option to get views instead: " +
  "a services directory URL gives one schema per service and one view per layer, a service URL gives one " +
  "view per layer in `main`, a layer URL gives one view. An ArcGIS Hub / Open Data site URL (e.g. " +
  "`https://gis.data.ca.gov`) works like a services directory: one schema per feature or map service in the " +
  "site's catalog, named after the item title. A Hub dataset page URL (`https://<site>/datasets/<itemId>_<n>`, " +
  "`.../datasets/<itemId>` or `.../datasets/<orgKey>::<slug>`) is resolved to the REST layer or service " +
  "behind it, in ATTACH and in `arcgis_query`. Simple WHERE predicates and spatial filters against a " +
  "constant (`geometry && <box>`, ST_Intersects, ST_Within, ...) run on the ArcGIS server, and results " +
  "page automatically; the `precision` " +
  "ATTACH option (default 7) sets how many decimals coordinates keep. Data is read live on every query. " +
  "Token-secured services need credentials: the secret ATTACH options `token`, `username` + `password` or " +
  "`client_id` + `client_secret` (an ArcGIS OAuth app) apply to the ATTACH `url`'s server, and list its secured " +
  "services as views. Or create a DuckDB secret of type `arcgis` (fields TOKEN, or USERNAME and PASSWORD, or " +
  "CLIENT_ID and CLIENT_SECRET, plus a SCOPE URL prefix), which `arcgis_query` uses for URLs under the scope " +
  "but which catalog listings cannot see:\n\n" +
  "```sql\nCREATE SECRET gis (TYPE arcgis, TOKEN getenv('ARCGIS_TOKEN'), " +
  "SCOPE 'https://gis.example.gov/arcgis/rest/services/');\n```\n\n" +
  "ATTACH credentials win over a secret. Errors 498/499 mean a missing, invalid or expired token.";

export const CATALOG_DOC_MD =
  "# VGI ArcGIS worker\n\n" +
  "**Query live ArcGIS FeatureServer and MapServer layers from DuckDB SQL.** Attach the worker with a `url` " +
  "option and every feature layer it finds becomes a view with a `GEOMETRY` column.\n\n" +
  "- `url` a services directory (`.../arcgis/rest/services`, one schema per service), a service " +
  "(`.../FeatureServer`, one view per layer) or a single layer (`.../FeatureServer/0`).\n" +
  "- `url` may also be an ArcGIS Hub / Open Data site (`https://gis.data.ca.gov`, one schema per service " +
  "in its catalog) or one of its dataset pages (`.../datasets/<itemId>_0`, resolved to the REST layer).\n" +
  "- `precision` decimal places kept in coordinates (default 7, about 1 cm).\n" +
  "- `arcgis.main.arcgis_query(url)` reads any layer by URL without attaching it.\n" +
  "- Token-secured services: ATTACH with `token`, `username` + `password`, or `client_id` + `client_secret` " +
  "(secret options, redacted from `duckdb_databases()`), or create an `arcgis` secret scoped to a URL prefix " +
  "for `arcgis_query`. Generated tokens are renewed automatically. In the DuckDB CLI, `getenv()` keeps a " +
  "credential out of the SQL text:\n\n" +
  "```sql\nATTACH 'arcgis' AS gis (TYPE vgi, LOCATION '/path/to/vgi-arcgis-worker',\n" +
  "  url 'https://gis.example.gov/arcgis/rest/services', token getenv('ARCGIS_TOKEN'));\n" +
  "CREATE SECRET gis_token (TYPE arcgis, TOKEN getenv('ARCGIS_TOKEN'),\n" +
  "  SCOPE 'https://gis.example.gov/arcgis/rest/services/');\n```\n\n" +
  "Simple filters (numeric comparisons, string equality and IN, IS NULL, prefix matches) and spatial " +
  "filters against a constant (`geometry && <box>`, `ST_Intersects`, `ST_Within`, ...) run on the ArcGIS " +
  "server; every filter is also applied exactly in the worker.";

export const SCHEMA_DOC_LLM =
  "The `main` schema holds `arcgis_query(url)`, which reads one ArcGIS layer or table by URL, plus, when " +
  "the catalog was attached with a service or layer `url`, one view per layer. For a token-secured layer, " +
  "`arcgis_query` uses the catalog's ATTACH credentials when they cover the URL's server, else the `arcgis` " +
  "secret whose SCOPE is the longest prefix of the URL.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "The entry point of the ArcGIS worker.\n\n" +
  "- `arcgis_query(url)`: every feature of one ArcGIS layer or table, paged automatically.\n" +
  "- Views over the attached service's layers, when the catalog was attached with a service or layer `url`.\n\n" +
  "Attach with a services directory or ArcGIS Hub site `url` to get one schema per service instead.";

export const AGENT_TEST_TASKS = [
  {
    name: "covington_parcels",
    prompt:
      "Using the arcgis worker, how many parcels does the Virginia statewide parcel layer " +
      "(https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Parcels/FeatureServer/0) " +
      "have in Covington City (FIPS 51580)?",
  },
  {
    name: "largest_of_two_cities",
    prompt:
      "Using the cities and counties layer at " +
      "https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Admin_Boundaries/FeatureServer/1, " +
      "which is larger by area: Covington or Buena Vista?",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "ArcGIS REST Feature Services",
  "vgi.subtitle": "Live SQL access to ArcGIS FeatureServer and MapServer layers, with filter pushdown.",
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
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "ArcGIS Functions",
  domain: "geospatial",
  "vgi.keywords": keywordsArray("arcgis, feature layer, query, geojson, gis"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};
