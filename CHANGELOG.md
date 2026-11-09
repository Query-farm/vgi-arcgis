# Changelog

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
