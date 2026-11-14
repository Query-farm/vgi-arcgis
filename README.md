<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

# vgi-arcgis

Query ArcGIS REST feature services from DuckDB with SQL. Point the worker at an ArcGIS
services directory, a FeatureServer/MapServer, a single layer, or an ArcGIS Hub / Open Data
site or dataset page, and each layer becomes a DuckDB view with typed columns and a
`GEOMETRY` column. Filters on attributes and spatial filters such as
`ST_Intersects(geometry, <area>)` run on the ArcGIS server.

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

The worker accepts compatible ArcGIS service URLs from any country or organization.
It has no built-in country or agency presets; geographic endpoints below are examples.

## Attaching

```sql
ATTACH 'arcgis' AS <name> (TYPE vgi, LOCATION '<worker>' [, url '<arcgis url>'] [, precision <n>]
                           [, token '...' | , username '...', password '...' | , client_id '...', client_secret '...']);
```

| Option | Default | Meaning |
|---|---|---|
| `url` | none | What to expose as views (see below). Omit it to use the query, summary and imagery functions directly. |
| `precision` | `7` | Decimal places kept in returned coordinates (ArcGIS `geometryPrecision`), 0–15. 7 is about 1 cm in longitude/latitude; lower values make responses smaller. |
| `token` | none | A pre-generated ArcGIS token for token-secured services. See [Authentication](#authentication). |
| `username`, `password` | none | An ArcGIS user; the worker generates and renews tokens. |
| `client_id`, `client_secret` | none | An ArcGIS OAuth app (client-credentials flow); the worker gets and renews app tokens. |

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

### Server-side summaries and imagery

Use any compatible layer URL with `arcgis_query` or the explicit summary functions.
These examples use public U.S. services:

```sql
ATTACH 'arcgis' (TYPE vgi, LOCATION '/abs/path/to/vgi-arcgis/bin/vgi-arcgis-worker');

-- Counts on the Census server, without downloading county features.
SELECT feature_count
FROM arcgis.main.arcgis_count(
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1',
  where_clause := 'STATE = ''36''');  -- 62 New York counties

-- Groups and aggregates on the server, returning only the summaries.
SELECT group_value AS state, statistic_value AS counties
FROM arcgis.main.arcgis_statistics(
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1',
  'OBJECTID', statistic := 'count', group_by := 'STATE',
  where_clause := 'STATE = ''36''')
ORDER BY state;

-- Filter a layer by a WGS84 box before counting it.
SELECT feature_count
FROM arcgis.main.arcgis_count(
  'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28',
  bbox := '-77.05,38.85,-77.04,38.86');
```

`arcgis_count(url, where_clause := '1=1', bbox := '')` returns one `feature_count BIGINT`,
including zero. `arcgis_statistics(url, statistic_field, statistic := 'sum', group_by := '',
where_clause := '1=1', bbox := '')` supports `count`, `sum`, `min`, `max`, `avg`, `stddev`
and `var`. `statistic_field` must be a numeric field, except that `count` accepts any
attribute and counts its non-null values. `group_by` accepts one field. Results are
`group_value VARCHAR` and `statistic_value DOUBLE`; ungrouped and null-valued groups have
a null `group_value`. Aggregate nulls remain null, and empty grouped results have no rows.
Large integer aggregates can lose precision in `DOUBLE`; use `arcgis_count` for exact
total feature counts. Missing, malformed or truncated responses raise errors.

These functions use **ArcGIS SQL and spatial semantics**, including the server's
collation. Pass source filters through `where_clause` and `bbox`; an outer DuckDB
`WHERE` filters the resulting summaries. These are explicit API operations, not
automatic pushdown of DuckDB `COUNT(*)` or `GROUP BY`. A box is
`xmin,ymin,xmax,ymax` in WGS84 and uses the server's intersects predicate. Boxes crossing
the antimeridian are rejected. Narrow the source filters if grouped results exceed
the service's transfer limit. Required NULL arguments are rejected; optional NULL
arguments use their defaults. All remote functions use the existing scoped credentials.

The summaries join like any other table. Parcels per square mile in four Virginia cities,
counting parcels on the server and taking each city's area from the boundaries layer:

```sql
SELECT b.NAMELSAD, p.statistic_value::BIGINT AS parcels,
       round(p.statistic_value / b.AREASQMI) AS parcels_per_sq_mi
FROM arcgis.main.arcgis_statistics(
  'https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Parcels/FeatureServer/0',
  'OBJECTID', statistic := 'count', group_by := 'FIPS',
  where_clause := 'FIPS IN (''51530'', ''51580'', ''51678'', ''51720'')') p
JOIN arcgis.main.arcgis_query(
  'https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Admin_Boundaries/FeatureServer/1') b
  ON b.STCOFIPS = p.group_value
ORDER BY parcels_per_sq_mi DESC;  -- Lexington City first, about 1,265
```

ImageServer services support pixel sampling through `arcgis_sample`:

```sql
SELECT point_index, TRY_CAST(value AS DOUBLE) AS elevation_m
FROM arcgis.main.arcgis_sample(
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer',
  '[[-77.0365,38.8977],[-77.04,38.90]]')
ORDER BY point_index;
```

`points_json` is a JSON array of WGS84 `[longitude, latitude]` pairs. The function sends
up to 100 points per request and accepts up to 10,000 points; an empty array returns
no rows. It uses `getSamples` with the default mosaic/pixel size and the first non-NoData
value. The raw `value` column preserves multiband and NoData text; `TRY_CAST` converts
single-band values. USGS 3DEP elevations are in meters. Other columns are `sample_x`,
`sample_y`, `spatial_reference` (JSON text), `raster_id` and `resolution` (source raster
coordinate-system units). `point_index` is the zero-based input position if the server
supplies `locationId`, otherwise NULL. Points outside coverage may produce no row.
This supports pixel sampling, not raster-file downloads or image export. ImageServer
URLs are passed directly to this function rather than attached as feature views.

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

It returns the layer's attribute fields, plus `geometry` (`GEOMETRY`, WGS84
longitude/latitude) for layers with geometry. The views are `SELECT * FROM arcgis_query(...)`,
so both push down the same filters.

## Authentication

Services that need an ArcGIS token answer error 499 ("Token Required") or 498 ("Invalid
Token"). There are two ways to give the worker credentials.

**ATTACH options** apply only to the server of the ATTACH `url` (the same scheme, host and
port), and need a `url`: without one they would be sent to any host a later `arcgis_query`
names. They also make a secured directory list its secured services as views. Give one of:

| Options | What happens |
|---|---|
| `token` | Sent as is. Not renewed: when it expires, attach again. Generate it with `client=requestip`, or with `referer` `https://github.com/Query-farm/vgi-arcgis`, which the worker sends as its `Referer`. |
| `username`, `password` | Exchanged for a 60-minute token at the server's token service (`authInfo.tokenServicesUrl` from `<server>/rest/info`: `…/arcgis/tokens/generateToken` on ArcGIS Server, `…/sharing/rest/generateToken` on a portal or ArcGIS Online). A wrong password fails the ATTACH. |
| `client_id`, `client_secret` | An ArcGIS OAuth app's client-credentials flow at the portal's `/sharing/rest/oauth2/token` (ArcGIS Online for `services.arcgis.com` hosts). Needs ArcGIS Online or an ArcGIS Enterprise portal. |

```sql
ATTACH 'arcgis' AS gis (TYPE vgi, LOCATION '/abs/path/to/vgi-arcgis-worker',
                        url 'https://gis.example.gov/arcgis/rest/services',
                        username 'analyst', password getenv('ARCGIS_PASSWORD'));
```

`getenv()` (DuckDB CLI) keeps the value out of the SQL text and your shell history. The
options are declared secret: `duckdb_databases()` shows `<redacted>`, and the VGI SDK carries
them encrypted inside the attach value, never in plaintext.

**A DuckDB secret** of type `arcgis` is used by `arcgis_query` for URLs under its `SCOPE`;
the longest matching scope wins. It takes `TOKEN`, or `USERNAME` and `PASSWORD`, or
`CLIENT_ID` and `CLIENT_SECRET`. The type exists once the worker is attached:

```sql
ATTACH 'arcgis' (TYPE vgi, LOCATION '/abs/path/to/vgi-arcgis-worker');
CREATE SECRET gis (TYPE arcgis, TOKEN getenv('ARCGIS_TOKEN'),
                   SCOPE 'https://gis.example.gov/arcgis/rest/services/');
SELECT count(*) FROM arcgis.main.arcgis_query(
  'https://gis.example.gov/arcgis/rest/services/Utilities/Water/FeatureServer/0');
```

Always give the secret a `SCOPE`: one without applies to every URL. Catalog listings can't
read secrets, so a secured service in an attached directory has views only with ATTACH
credentials; `arcgis_query` works with either. When both apply, the ATTACH credentials win.

How credentials are handled:

- Generated tokens stay in the worker's memory, keyed by token endpoint and a hash of the
  identity. They are renewed two minutes before they expire, and once more if the server
  answers 498. They never go into query state, logs or error messages: URLs are logged
  and reported with `token=<redacted>`.
- Credentials are sent only over HTTPS (plain HTTP is allowed to `localhost` only).
- Cached metadata is keyed by identity, so a shared HTTP worker never serves one attach's
  secured metadata to another.
- Web-tier authentication (IWA, PKI) and interactive OAuth sign-in are not supported.

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
- in one request otherwise, falling back to `returnIdsOnly` and bounded `objectIds`
  batches if the result is truncated. IDs are sorted and deduplicated. If the service
  truncates a batch, the worker reduces it; unsupported or incomplete ID responses fail
  rather than returning partial data.

Offset paging advances the requested page window, including when spatial-index filtering
returns a short or empty page with `exceededTransferLimit=true`. An empty keyset page with
more results falls back to object IDs. Missing feature arrays and non-advancing keyset
cursors are errors. MapServer object-ID fields can also be identified from field metadata.

The ID fallback carries a small cursor across requests. Each process caches up to four
scan-specific ID lists of at most one million IDs each, for up to five minutes. A different
HTTP process or an evicted cache entry re-enumerates IDs after the cursor. No credentials
or whole-layer ID arrays travel in the cursor. These remain live reads, not a transactional
snapshot of a dataset being edited during a scan.

Requests retry on HTTP 429 and 5xx (honouring `Retry-After`) and time out after 60 s. Layer
metadata is cached for 5 minutes.

## Limitations

- **Token-secured services need credentials** (see [Authentication](#authentication)). In
  a directory attached without them, or whose credentials a service rejects (ArcGIS error
  498/499, HTTP 401/403), that service appears as a schema with no views and the worker
  logs a warning. Web-tier (IWA/PKI) authentication is not supported. ATTACH credentials
  apply only to the ATTACH `url`'s own server, so a Hub site's items, which usually live on
  other servers, are read anonymously; use `arcgis_query` with a scoped `arcgis` secret for
  secured ones.
- **Hub sites:** only catalogs defined by groups are read (current `catalogV2` sites and
  older `catalog.groups` sites). The search API stops at 10,000 items. Slug URLs are matched
  against item titles because no public API resolves slugs. If one fails, use the
  `<itemId>_<n>` form or the REST URL. Other non-REST URLs are rejected unless their host
  is a Hub site.
- **Listing every view of a Hub site is slow.** `duckdb_views()`, `SHOW TABLES` and
  `information_schema` walk every schema of every attached database. On a site with
  thousands of services, that fetches the metadata of each one, from many different servers.
  Query views by name, or attach a single dataset or service instead.
- **ImageServer** supports explicit pixel sampling with `arcgis_sample`, but is not
  exposed as feature views. GeocodeServer and GPServer services are skipped.
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
make test-live LIVE_CASES=test/live/us_public.json # optional U.S. example profile
```

The SQL tests run against `test/mock_api/server.py`, an offline mock of the ArcGIS REST API.
It covers paging modes, filters, multipolygons with holes, an Esri-JSON-only layer, a
non-spatial table, a legacy server, and throttling (429 on first request). It also mocks the
ArcGIS Hub and sharing APIs: domain lookup, both site catalog formats, paged search, dataset
IDs and the site search used for slugs. The fixture queries in `make check` do not
need live ArcGIS services. Dependency/extension
installation and metadata validation may still use the network.
`vgi-agent-tests.yaml` holds example tasks against public ArcGIS services.

`make test-live LIVE_CASES=<path>` runs a caller-selected JSON file through stock DuckDB
2.0.0 with the signed VGI extension from `query_farm`. There is no default country or
provider. The optional `test/live/us_public.json` profile covers server counts/statistics,
spatial feature queries and elevation sampling using public U.S. endpoints. To check
other services, create a file with `schema_version: 1` and a nonempty `checks` array;
each check contains a `name`, `sql` (using the `arcgis` catalog), and expected `rows`
as an array of arrays. Project JSON-compatible values and order multirow results explicitly.

The runner prints individual results and writes the tested SQL, engine/extension
versions and results to `.tools/live.json`. A 180-second deadline covers the entire run;
invoke `scripts/test_live.py --cases <path> --timeout <seconds>` to change it.
Live checks are opt-in because service outages and changing data should not make the
offline fixture suite flaky. `make check` uses Haybarn 2.0.0rc11 for its SQL tests.

`src/` layout: `catalog.ts` (ATTACH and views), `discovery.ts` (walking directories and
services), `hub.ts` (Hub site and dataset URLs), `query.ts` (`arcgis_query`), `where.ts`
(attribute filter translation), `spatial.ts` (spatial filter translation), `wkb.ts`
(GeoJSON → WKB, WKB boxes), `esri.ts`
(metadata, types, Esri JSON → GeoJSON), `http.ts` (retries, caching), `options.ts`,
`paging.ts` (scan cursors and legacy ID batches),
`summary.ts` (server aggregates) and `imagery.ts` (pixel sampling).

## Support

Open an issue on this repository. For VGI itself, see [query.farm](https://query.farm).

## License

[MIT](LICENSE) © Query Farm LLC

## Executed notebooks

[Explore county land and water shares with SQL](notebooks/README.md) in a portable, executed notebook with a separate cutoff experiment.
