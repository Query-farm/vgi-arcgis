# Changelog

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
