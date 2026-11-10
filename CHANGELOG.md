# Changelog

## Unreleased

Breaking: `arcgis_query` returns `geometry` (`GEOMETRY`) instead of `geometry_geojson`
(`VARCHAR`). Use `ST_AsGeoJSON(geometry)` for the old text.

- Spatial filter pushdown. `geometry && <constant>`, and `ST_Intersects`, `ST_Within`,
  `ST_Contains`, `ST_ContainsProperly`, `ST_Covers`, `ST_CoveredBy`, `ST_Touches`,
  `ST_Overlaps`, `ST_Crosses` or `ST_Equals` against a constant geometry, become an ArcGIS
  envelope-intersects query: the server returns only features near the constant, and DuckDB
  applies the exact predicate. On VGIN, parcels touching a box in Covington take about 1 s
  instead of downloading 3 million parcels. Deriving the box from the `ST_` predicates needs
  VGI `fd85f2e` or later.
- The query envelope is widened by the coordinate rounding step and by 0.5% of its size, for
  the server's reprojection into the layer's coordinate system. Without it, edge-touching
  boxes lost features on a State Plane layer (DC GIS, 20 of 48 boxes).
- Geometry is a native `GEOMETRY` column (geoarrow WKB), so the views are plain
  `SELECT * FROM arcgis_query(...)` and reading them no longer needs the `spatial` or `json`
  extension.
- ArcGIS Hub / Open Data URLs. `ATTACH ... (url 'https://gis.data.ca.gov')` lists one schema
  per Feature Service and Map Service item in the site's catalog. It reads both `catalogV2`
  and older `catalog.groups` sites, and works with custom domains, `*.hub.arcgis.com` and
  `*.opendata.arcgis.com`. Schemas are named after item titles, deduplicated by service URL
  (FeatureServer over MapServer), and tagged with `arcgis.item_id`. A Hub service that
  cannot be read gets no views instead of failing the listing.
- Hub dataset pages (`/datasets/<itemId>_<n>`, `/datasets/<itemId>`,
  `/datasets/<orgKey>::<slug>`, also `/maps/…`, `/items/…` and `/about`/`/explore` suffixes)
  resolve to their REST layer or service, both as an ATTACH `url` and in `arcgis_query(url)`.
- A non-REST URL whose host is not a Hub site still fails at ATTACH, with a clearer message.
- New worker environment variables `ARCGIS_HUB_API` and `ARCGIS_PORTAL_API` override the Hub
  and ArcGIS Online API roots (used by the offline tests).
- Token-secured services. ATTACH options `token`, `username` + `password` (tokens generated
  at the server's token service) and `client_id` + `client_secret` (an ArcGIS OAuth app's
  client-credentials flow) apply to the ATTACH `url`'s server, so a secured directory now
  lists its secured services as views. They are declared secret: redacted from
  `duckdb_databases()` and carried encrypted in the attach value. Write
  `token getenv('ARCGIS_TOKEN')` to keep a token out of the SQL.
- A DuckDB secret type `arcgis` (`TOKEN`, or `USERNAME`/`PASSWORD`, or
  `CLIENT_ID`/`CLIENT_SECRET`): `arcgis_query` uses the one whose `SCOPE` is the longest
  prefix of the layer URL. ATTACH credentials take precedence.
- Generated tokens are cached in memory, renewed before they expire and once on a 498.
- Errors 498/499 say which ATTACH option or secret to set or check. A wrong password fails
  the ATTACH.
- Tokens, passwords and client secrets are redacted from every log line and error message,
  and metadata is cached per identity.

## 0.3.0

- VGI protocol 3.2: built on @query-farm/vgi 0.49.1, so the worker loads in the current
  vgi extension (Haybarn 2.0.0rc11 community build 7d716ef). Workers on protocol 3.1 are
  rejected by it. No behaviour changes.

Targets: @query-farm/vgi 0.49 · VGI protocol 3.2 · Haybarn 2.0.0rc11 and DuckDB 2.0.0.

## 0.2.0

Breaking: some schema and view names change.

- Colliding layer names are told apart by their group layers, and every member of a
  collision is renamed, so names no longer depend on listing order. On USGS 3DEP,
  `l_1_meter` / `l_1_meter_18` are now `dem_product_index_1_meter` / `query_1_meter`. The
  layer ID is appended only when groups can't separate them.
- A name that starts with a digit gets a leading `_` instead of `l_` (`l_49_999` →
  `_49_999`).
- Names without spaces are split at CamelCase boundaries (`USTopoAvailability` →
  `us_topo_availability`).
- Views carry `arcgis.layer_id` and `arcgis.layer_path` tags.
- Faster first rows: a scan with geometry starts with a 100-row page and grows fourfold to
  the layer's `maxRecordCount`, so `SELECT * … LIMIT 10` on a large layer takes ~0.4 s
  instead of fetching a full 2,000-feature page first. Attribute-only scans still use full
  pages.

## 0.1.1

- A token-secured service in a services directory (ArcGIS error 498/499, HTTP 401/403)
  is listed with no views and a warning instead of failing. Before, one subscriber-only
  service broke `duckdb_views()`, `SHOW ALL TABLES`, and DuckDB's "did you mean"
  suggestions for every other service in the directory (seen on Esri's ArcGIS Online
  org).
- Debug logging (`--log-level debug`) shows each ArcGIS request.
- Tested against ArcGIS Online, DC GIS, Census TIGERweb and Esri sampleserver6 as well
  as VGIN.

## 0.1.0

First release.

- `ATTACH … (TYPE vgi, url '…', precision n)` exposes an ArcGIS REST services directory
  (one schema per FeatureServer/MapServer), a service, or a single layer as DuckDB views
  with typed columns and a WGS84 `GEOMETRY` column.
- `arcgis_query(url)` reads one layer by URL, returning its attributes plus
  `geometry_geojson`.
- Attribute filters are sent to ArcGIS as `where` when the translation can never drop a
  matching row; every pushed predicate is re-applied exactly. Projection pushdown limits
  `outFields`.
- Paging by object ID or offset; a truncated single-request result is an error.
- Retries on 429/5xx with `Retry-After`, 60 s timeouts, 5-minute metadata cache.
- Not yet: token-secured services, ArcGIS Hub site URLs, spatial filter pushdown.

Targets: @query-farm/vgi 0.48 · VGI protocol 3.1 · Haybarn 2.0.0rc11 and DuckDB 2.0.0 ·
vgi-lint-check 2.x (unpinned). Starter template v1.1.4.
