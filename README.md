<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

# vgi-arcgis

Query ArcGIS REST feature services from DuckDB with SQL. Point the worker at an ArcGIS
services directory, a FeatureServer/MapServer, a single layer, or an ArcGIS Hub / Open Data
site or dataset page, and each layer becomes a DuckDB view with typed columns and a
`GEOMETRY` column. Filters on attributes run on the
ArcGIS server.

```sql
INSTALL spatial; LOAD spatial;
ATTACH 'arcgis' AS va (TYPE vgi, LOCATION '/abs/path/to/vgi-arcgis-worker',
                       url 'https://vginmaps.vdem.virginia.gov/arcgis/rest/services');

SELECT LOCALITY, count(*)
FROM va.va_base_layers_va_parcels.virginia_parcels
WHERE FIPS = '51580'          -- runs on the ArcGIS server
GROUP BY ALL;
```

It is built on [VGI](https://query.farm/vgi), which lets DuckDB call a worker process as if
it were part of the database. Nothing is copied ahead of time: every query reads the
service live.

## Attaching

```sql
ATTACH 'arcgis' AS <name> (TYPE vgi, LOCATION '<worker>' [, url '<arcgis url>'] [, precision <n>]);
```

| Option | Default | Meaning |
|---|---|---|
| `url` | none | What to expose as views (see below). Omit it to use only `arcgis_query()`. |
| `precision` | `7` | Decimal places kept in returned coordinates (ArcGIS `geometryPrecision`), 0–15. 7 is about 1 cm in longitude/latitude; lower values make responses smaller. |

What the `url` points at decides the layout:

| `url` | Schemas and views |
|---|---|
| A services directory, e.g. `…/arcgis/rest/services`, or a folder in it | One schema per FeatureServer/MapServer (folder `/` becomes `_`), one view per layer and table. |
| A service, `…/FeatureServer` or `…/MapServer` | One view per layer and table, in `main`. |
| A layer, `…/FeatureServer/0` | One view in `main`. |
| An ArcGIS Hub / Open Data site, e.g. `https://gis.data.ca.gov` (any page of it that is not a dataset) | One schema per feature or map service in the site's catalog, one view per layer and table. |
| A Hub dataset page, e.g. `https://<site>/datasets/<itemId>_0` | Resolved to the REST layer or service behind it, then as above. |

When a service has both a FeatureServer and a MapServer, the FeatureServer is used.
Services are listed when you attach; each schema's views are fetched the first time you use
them.

### ArcGIS Hub and Open Data sites

```sql
ATTACH 'arcgis' AS ca (TYPE vgi, LOCATION '/abs/path/to/vgi-arcgis-worker',
                       url 'https://gis.data.ca.gov');
SELECT count(*) FROM ca.caltrans_districts.district_tiger_lines;   -- 12
```

A site URL works like a services directory. The worker looks the host up in the Hub API
(custom domains, `*.hub.arcgis.com` and `*.opendata.arcgis.com` all work), reads the site's
catalog groups, and lists the Feature Service and Map Service items shared to them. Each
service becomes a schema named after the item title. Items that point at the same service, or
at a FeatureServer and its MapServer twin, are listed once (FeatureServer first). The schema
comment is the title and summary, and the tags carry `arcgis.service_url` and
`arcgis.item_id`. Duplicate titles are qualified by the item owner, then by the item ID.
Items without a REST URL (web apps, files, StoryMaps) are skipped. The California State
Geoportal lists about 2,000 schemas in a second or two. The listing is cached for 5 minutes,
and views are fetched per schema the first time you use it. A service that is secured,
moved or down shows up as a schema with no views, and the worker logs a warning.

Dataset pages resolve to the REST URL behind them, both in ATTACH and in `arcgis_query`:

| Dataset URL | Resolved through |
|---|---|
| `…/datasets/<itemId>_<n>` (also `/maps/…`, `/items/…`, with `/about`, `/explore`, … suffixes) | The Hub dataset API, giving layer `<n>`. |
| `…/datasets/<itemId>` | The item's service URL. |
| `…/datasets/<orgKey>::<slug>`, `…/datasets/<slug>` | The site's search, matching the slug against item titles. When several match, the org key (or the site's own org) decides. If it's still ambiguous, the error lists the candidates. |

```sql
SELECT count(*) FROM arcgis.main.arcgis_query(
  'https://gis.data.ca.gov/datasets/CALTRANS::caltrans-districts');                    -- 12
```

The Hub and portal API roots can be overridden with the `ARCGIS_HUB_API` (default
`https://hub.arcgis.com`) and `ARCGIS_PORTAL_API` (default
`https://www.arcgis.com/sharing/rest`) environment variables of the worker process. The
tests use these to point at the mock.

### Names

Schema and view names are valid DuckDB identifiers that never need quoting, and they stay the
same as long as the service's structure does:

- Lowercase words joined by `_`. Names without spaces, like most service names, are split at
  CamelCase boundaries: `USTopoAvailability` becomes `us_topo_availability`.
- A name that would start with a digit gets a leading `_`: `_3dep_elevation_index`,
  `_2024_tile_index`.
- When names collide, every one of them is renamed, not just the later ones. Each takes the name
  of its enclosing group layer, innermost first. For example, USGS lists "1 meter" under both
  "DEM Product Index" and "Query", which become `dem_product_index_1_meter` and
  `query_1_meter`. Only when groups don't tell them apart is the layer ID appended
  (`sewers_1999_5`, `sewers_1999_31`).

Each view's tags record where it came from: `arcgis.layer_url`, `arcgis.layer_id` and
`arcgis.layer_path` (`DEM Product Index > 1 meter`).

```sql
SELECT view_name, tags['arcgis.layer_path'] FROM duckdb_views() WHERE database_name = 'va';
```

```sql
SHOW ALL TABLES;                                   -- after ATTACH
DESCRIBE va.va_base_layers_va_admin_boundaries.virginia_cities_and_counties;
```

### Reading a layer without attaching it

`arcgis_query(url)` reads one layer by URL. It is in `main` of every attached worker:

```sql
ATTACH 'arcgis' (TYPE vgi, LOCATION '/abs/path/to/vgi-arcgis-worker');

SELECT * FROM arcgis.main.arcgis_query(
  'https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Parcels/FeatureServer/0')
WHERE FIPS = '51580';
```

It returns the layer's attribute fields, plus `geometry_geojson` (VARCHAR, WGS84 GeoJSON) for
layers with geometry. Parse that with `ST_GeomFromGeoJSON(geometry_geojson)`. The views
already do this, which is why views need the `spatial` and `json` extensions loaded.

## Columns and types

| ArcGIS field type | DuckDB type |
|---|---|
| OID, Integer | `INTEGER` |
| BigInteger | `BIGINT` |
| SmallInteger | `SMALLINT` |
| Single / Double | `FLOAT` / `DOUBLE` |
| String, GUID, GlobalID, DateOnly, TimeOnly, TimestampOffset | `VARCHAR` |
| Date | `TIMESTAMP_MS` |

Raster, Blob, XML and geometry-typed attribute fields are skipped. Each column's comment is
the field's alias. Geometry is always returned in WGS84 (`outSR=4326`).

## What runs on the server

DuckDB passes the query's filters and its column list to the worker:

- **Sent to ArcGIS as `where`:**
  - on numeric and date columns: `=`, `<>`, `<`, `<=`, `>`, `>=`, `IN`, `NOT IN`
  - on string columns: `=`, `IN`, prefix/suffix/contains `LIKE`
  - on any column: `IS [NOT] NULL`
  - `AND` of any of these, and `OR` when every branch translates
- **Applied by the worker after fetching:** everything else, such as string ranges and `<>`
  on strings. ArcGIS string comparison depends on the server's database and collation, so
  only translations that can never drop a matching row are sent. The worker then re-applies
  every predicate exactly.
- **Columns:** only the columns the query uses are requested (`outFields`).
- **Not pushed down:** spatial predicates (`ST_Intersects`, `&&`). A spatial filter or join
  is evaluated in DuckDB after the layer, or the attribute-filtered part of it, is fetched.

## Paging

Results are fetched in pages. With geometry, the first page is 100 rows and pages grow
fourfold up to the layer's `maxRecordCount`, so the first rows and `LIMIT` queries come back
quickly. Attribute-only scans use `maxRecordCount` pages throughout. Pages are fetched:

- by object ID, when the layer supports ordering;
- by offset, when it only supports pagination;
- in one request otherwise. If such a server truncates the result, the query fails with an
  error rather than returning partial data.

Requests retry on HTTP 429 and 5xx (honouring `Retry-After`) and time out after 60 s. Layer
metadata is cached for 5 minutes.

## Limitations

- **Public services only.** Token-secured services are not supported yet. In a directory,
  a service that requires a token (ArcGIS error 498/499, HTTP 401/403) appears as a schema
  with no views, and the worker logs a warning.
- **Hub sites:** only catalogs defined by groups are read (current `catalogV2` sites and
  older `catalog.groups` sites). The search API stops at 10,000 items. Slug URLs are matched
  against item titles because no public API resolves slugs. If one fails, use the
  `<itemId>_<n>` form or the REST URL. Other non-REST URLs are rejected unless their host
  is a Hub site.
- **Listing every view of a Hub site is slow.** `duckdb_views()`, `SHOW TABLES` and
  `information_schema` walk every schema of every attached database. On a site with
  thousands of services, that fetches the metadata of each one, from many different servers.
  Query views by name, or attach a single dataset or service instead.
- **No spatial pushdown** (see above).
- **Imagery and other services** (ImageServer, GeocodeServer, GPServer) are skipped.
- **DuckDB 2.0 axis order.** Geometry is longitude/latitude. Spheroid functions such as
  `ST_Area_Spheroid` need `SET geometry_always_xy = true` (the default from DuckDB 2.1).
- A misspelled table name makes DuckDB look for similar names, which fetches the
  metadata of each similarly named service (cached for 5 minutes).

## Getting the worker

**Release binaries:** each [release](https://github.com/Query-farm/vgi-arcgis/releases)
attaches a standalone `vgi-arcgis-worker` for Linux (x86-64, arm64), macOS (arm64) and
Windows (x86-64). They need no Bun or Node. Point `LOCATION` at the file.

**From source** ([Bun](https://bun.sh) ≥ 1.3):

```bash
git clone https://github.com/Query-farm/vgi-arcgis && cd vgi-arcgis
bun install
# LOCATION '/abs/path/to/vgi-arcgis/bin/vgi-arcgis-worker'
```

**Hosted over HTTP:**

```bash
docker build -t vgi-arcgis . && docker run -p 8000:8000 vgi-arcgis   # GET /health
```

```sql
ATTACH 'arcgis' (TYPE vgi, LOCATION 'https://your-host/', url '...');
```

Put a hosted worker behind TLS and authentication; see
[authentication](https://query.farm/vgi/authentication).

## Tested against

Stock DuckDB 2.0.0 (VGI from the `query_farm` repository) and Haybarn 2.0.0rc11:

| Server | Kind | Checked |
|---|---|---|
| [VGIN](https://vgin.vdem.virginia.gov) (Virginia) | ArcGIS Enterprise, 71 services | parcels by FIPS (5,811 for Covington), polygons, spatial join |
| Esri ArcGIS Online (`services.arcgis.com/P3ePLMYs2RVChkJx`) | hosted, 1,349 services, includes subscriber-only services | state boundaries, population, `ST_Area_Spheroid` |
| DC GIS (`maps2.dcgis.dc.gov`) | ArcGIS Enterprise 11.5, folder attach | 8 wards (2022), 177.5 km² |
| Census TIGERweb | MapServer only, string OID field, 100,000-row pages | 133 Virginia counties, 3,235 US counties |
| Esri sampleserver6 | ArcGIS Server 10.91 | world cities (points) |
| NYS GIS (`gisservices.its.ny.gov`) | ArcGIS Server 10.81, 22 services | 62 counties, 141,343 km² |
| USGS National Map (`index.nationalmap.gov`) | ArcGIS 11.3, index layers | 22 HU2 hydrologic regions |
| Caltrans, a California State Geoportal (Hub) dataset, by its layer URL | ArcGIS Server | 12 districts |
| [California State Geoportal](https://gis.data.ca.gov) (Hub site, custom domain) | ArcGIS Hub, `catalogV2`, 44 groups | 1,999 schemas; 12 Caltrans districts via the site schema, the `CALTRANS::caltrans-districts` slug and `<itemId>_0`; a CAL FIRE MapServer `<itemId>_0` dataset |
| [DataHub DC](https://opendata.dc.gov) (Hub site) | ArcGIS Hub, `catalogV2`, 53 groups | 1,502 schemas |

## Testing

```bash
make check     # lint, unit tests, SQL tests over stdio/launch/HTTP, metadata lint
```

The SQL tests run against `test/mock_api/server.py`, an offline mock of the ArcGIS REST API.
It covers paging modes, filters, multipolygons with holes, an Esri-JSON-only layer, a
non-spatial table, a legacy server, and throttling (429 on first request). It also mocks the
ArcGIS Hub and sharing APIs: domain lookup, both site catalog formats, paged search, dataset
IDs and the site search used for slugs. Nothing in
`make check` touches the network.
`vgi-agent-tests.yaml` holds live tasks against Virginia's VGIN services.

`src/` layout: `catalog.ts` (ATTACH and views), `discovery.ts` (walking directories and
services), `hub.ts` (Hub site and dataset URLs), `query.ts` (`arcgis_query`), `where.ts` (filter translation), `esri.ts`
(metadata, types, Esri JSON → GeoJSON), `http.ts` (retries, caching), `options.ts`.

## Support

Open an issue on this repository. For VGI itself, see [query.farm](https://query.farm).

## License

[MIT](LICENSE) © Query Farm LLC
