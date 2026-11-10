<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

# vgi-arcgis

Query ArcGIS REST feature services from DuckDB with SQL. Point the worker at an ArcGIS
services directory, a FeatureServer/MapServer, or a single layer, and each layer becomes a
DuckDB view with typed columns and a `GEOMETRY` column. Filters on attributes and spatial
filters such as `ST_Intersects(geometry, <area>)` run on the ArcGIS server.

```sql
INSTALL spatial; LOAD spatial;   -- for the ST_ functions; reading the views needs no extension
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

When a service has both a FeatureServer and a MapServer, the FeatureServer is used.
Services are listed when you attach; each schema's views are fetched the first time you use
them.

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

It returns the layer's attribute fields, plus `geometry` (`GEOMETRY`, WGS84
longitude/latitude) for layers with geometry. The views are `SELECT * FROM arcgis_query(...)`,
so both push down the same filters.

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
the field's alias. Geometry is always returned in WGS84 (`outSR=4326`), rounded to
`precision`, as a `GEOMETRY` column named `geometry`.

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
- **Sent to ArcGIS as a spatial filter:** `geometry && <constant>`, and `ST_Intersects`,
  `ST_Within`, `ST_Contains`, `ST_ContainsProperly`, `ST_Covers`, `ST_CoveredBy`,
  `ST_Touches`, `ST_Overlaps`, `ST_Crosses` or `ST_Equals` between `geometry` and a constant
  geometry. The server returns the features whose envelope meets the constant's envelope
  (`esriSpatialRelEnvelopeIntersects`), and DuckDB then applies the exact predicate. The
  envelope is widened slightly before it is sent: by the coordinate rounding step
  (`precision`) and by 0.5% of its size, because the server reprojects it into the layer's
  coordinate system. On a layer stored in State Plane, boxes that only touch a feature's
  envelope lost that feature 20 times in 48 without the margin, and never with it.
- **Applied by the worker after fetching:** everything else, such as string ranges and `<>`
  on strings. ArcGIS string comparison depends on the server's database and collation, so
  only translations that can never drop a matching row are sent. The worker then re-applies
  every predicate exactly.
- **Columns:** only the columns the query uses are requested (`outFields`).
- **Not pushed down:** spatial joins (the other side is not a constant), `ST_DWithin`,
  `ST_Disjoint` and `NOT` forms, and spatial filters combined with `OR`.

```sql
-- Only the parcels near the box are downloaded, not the state's millions.
SELECT count(*) FROM va.va_base_layers_va_parcels.virginia_parcels
WHERE ST_Intersects(geometry, ST_MakeEnvelope(-80.005, 37.785, -79.99, 37.795));
```

Deriving the box from `ST_Intersects` and the other exact predicates needs VGI `fd85f2e`
or later (stock DuckDB gets it from the `query_farm` repository). Older VGI builds push only
an explicit `geometry && <constant>`.

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
- **ArcGIS REST URLs only.** ArcGIS Hub / Open Data site URLs are rejected. Use the REST
  services directory behind the site; Hub datasets point at those layers.
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

## Testing

```bash
make check     # lint, unit tests, SQL tests over stdio/launch/HTTP, metadata lint
```

The SQL tests run against `test/mock_api/server.py`, an offline mock of the ArcGIS REST API.
It covers paging modes, filters, multipolygons with holes, an Esri-JSON-only layer, a
non-spatial table, a legacy server, and throttling (429 on first request). Nothing in
`make check` touches the network.
`vgi-agent-tests.yaml` holds live tasks against Virginia's VGIN services.

`src/` layout: `catalog.ts` (ATTACH and views), `discovery.ts` (walking directories and
services), `query.ts` (`arcgis_query`), `where.ts` (attribute filter translation),
`spatial.ts` (spatial filter translation), `wkb.ts` (GeoJSON → WKB, WKB boxes), `esri.ts`
(metadata, types, Esri JSON → GeoJSON), `http.ts` (retries, caching), `options.ts`.

## Support

Open an issue on this repository. For VGI itself, see [query.farm](https://query.farm).

## License

[MIT](LICENSE) © Query Farm LLC
