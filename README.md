<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

# vgi-arcgis

Query ArcGIS REST feature services from DuckDB with SQL. Point the worker at an ArcGIS
services directory, a FeatureServer/MapServer, or a single layer, and each layer becomes a
DuckDB view with typed columns and a `GEOMETRY` column. Filters on attributes run on the
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

Names are lowercased and reduced to `[a-z0-9_]`. A name that starts with a digit gets an `l_`
prefix. When a service has both a FeatureServer and a MapServer, the FeatureServer is used.
Services are listed when you attach; each schema's views are fetched the first time you use
them.

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

Results are fetched in pages of the layer's `maxRecordCount`:

- by object ID, when the layer supports ordering;
- by offset, when it only supports pagination;
- in one request otherwise. If such a server truncates the result, the query fails with an
  error rather than returning partial data.

Requests retry on HTTP 429 and 5xx (honouring `Retry-After`) and time out after 60 s. Layer
metadata is cached for 5 minutes.

## Limitations

- **Public services only.** Token-secured services are not supported yet.
- **ArcGIS REST URLs only.** ArcGIS Hub / Open Data site URLs are rejected. Use the REST
  services directory behind the site; Hub datasets point at those layers.
- **No spatial pushdown** (see above).
- **Imagery and other services** (ImageServer, GeocodeServer, GPServer) are skipped.
- Tested with Haybarn 2.0 and stock DuckDB; see [Testing](#testing).

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
services), `query.ts` (`arcgis_query`), `where.ts` (filter translation), `esri.ts`
(metadata, types, Esri JSON → GeoJSON), `http.ts` (retries, caching), `options.ts`.

## Support

Open an issue on this repository. For VGI itself, see [query.farm](https://query.farm).

## License

[MIT](LICENSE) © Query Farm LLC
