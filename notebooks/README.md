# ArcGIS SQL examples

Two executed stories use native public worker release **v0.6.0**:

- [How much of a county is water?](01_county_land_and_water.ipynb) retrieves the complete Massachusetts county population, reconciles exact count and remote land/water sums, then separates area weighting from an exploratory cutoff. Change `WATER_SHARE_THRESHOLD` from 0.25 to 0.50.
- [Requested points are not the same as returned samples](02_requested_points_and_returned_samples.ipynb) preserves five authored coordinates while the live USGS service may return fewer sample rows. It distinguishes omitted samples from numeric elevations before an inclusive cutoff. Change `ELEVATION_THRESHOLD_M` from 300 to 1000.

The attributes and raster samples are **live public data**. Coordinate labels are authored approximate descriptions, not geocoded boundaries or verified summit positions. There is no synthetic/replay fallback: failed requests stop execution. Metadata, features, summaries and samples are separate service requests, not atomic snapshots. Every run records its UTC retrieval interval, source description and sorted result fingerprint.

## Run from this folder or one notebook

Install [uv](https://docs.astral.sh/uv/), then:

```bash
uv sync --locked
uv run --locked vgi-notebooks 01_county_land_and_water.ipynb
uv run --locked vgi-notebooks 02_requested_points_and_returned_samples.ipynb
```

The local environment pins shared **v0.3.41** with `[runner]`. A Colab badge opens one notebook; its conditional bootstrap installs only the shared base package in that kernel. `prepare("arcgis")` retrieves one helper from immutable public commit `3d1cefd0f633617f4654c118c994e963cb8b9226` and checks SHA-256. No parent checkout or worker build is needed. The helper retrieves only public provenance metadata and draws SQL-returned data; extraction, classification, aggregation and checks remain visible SQL.

For a local editor:

```bash
uv run --locked python -m ipykernel install --user --name arcgis-examples \
  --display-name "Python (vgi-arcgis notebooks)"
```

Restart and Run All after editing a parameter. Every notebook shows:

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'arcgis' (TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-arcgis@v0.6.0');
```

Haybarn 2.0.0rc11 downloads the released native platform artifact, not a source-checkout binary. v0.6.0 has macOS arm64, Linux amd64/arm64 and Windows amd64 artifacts. First use needs GitHub/extension retrieval; every run needs the public source endpoints. An anonymous cold-cache release download and four-function catalog probe passed with no GitHub token in the test environment. Release `ed35bebf068d361d80b7fefe9e3fdbdd6af367c8` is pinned explicitly. Upgrade by changing the literal tag and reviewing the catalog, data, defaults and experiment again.

Shared connection setup creates a fresh empty SQL-secret directory, disables persistent secrets and sets UTC before ATTACH. No ArcGIS token or user credential is supplied. The notebooks temporarily clear known test endpoint overrides and restore them at cleanup. They never read, delete or modify saved user SQL secrets. No ATTACH discovery URL is configured, avoiding unrelated service enumeration.

## Separate experiments

```bash
uv run --locked vgi-notebooks 01_county_land_and_water.ipynb \
  --parameters '{"WATER_SHARE_THRESHOLD":0.50}' --output-dir artifacts/water-50
uv run --locked vgi-notebooks 02_requested_points_and_returned_samples.ipynb \
  --parameters '{"ELEVATION_THRESHOLD_M":1000}' --output-dir artifacts/elevation-1000
```

The runner requires a separate destination and protects saved defaults. Experiment copies retain branding and documentation. Charts use native SVG plus exact GitHub image links for committed defaults; PNGs are review artifacts only.

A live experiment is a controlled parameter comparison **only if the source fingerprints match**. County attributes, remote summaries, requested coordinates and raw sample fields are compared explicitly during validation. A future service update may change them independently of the threshold.

## Population and interpretation

The [Census TIGERweb county layer](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1) is restricted to state FIPS25. `arcgis_count` and `arcgis_statistics` receive explicit named server filters; the feature query's direct `STATE` equality is pushed to the service and checked locally. Only identifiers and area attributes are requested, with no county geometry. All matching rows are materialized once; an outer `LIMIT` is not used to imply a network bound. Later cutoff analyses read only local tables.

[Census area definitions](https://www2.census.gov/geo/pdfs/reference/GARM/Ch15GARM.pdf) distinguish land and water. Source area attributes are square metres, converted to km². The equal-county mean and area-weighted share answer different questions. Explicit server sums are DOUBLE; the notebook permits one square metre of rounding when reconciling them with local integer sums. This does not prove an atomic retrieval or certify geographic definitions. Water share is not a flood-risk, water-quality, population or development measure.

The [USGS dynamic 3DEP ImageServer](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer) receives one five-point WGS84 multipoint payload; the worker batches at most 100 inputs per service request. The service may omit a location. SQL requires attributable IDs and matching WGS84 coordinates, left-joins from all five requested points and keeps raw value text. Only finite numeric values become elevations. Neither omitted nor NoData/nonnumeric values are converted to zero or assigned an elevation class. All three classification categories remain in the chart, including zero counts.

[USGS 3DEP product metadata](https://data.usgs.gov/datacatalog/data/USGS%3A77ae0551-c61e-4979-aedd-d797abdcde0e) documents bare-earth elevation values in metres. The example uses the service's default multi-resolution mosaic and sampling behavior, not a selected source tile or survey control. Raster IDs and reported resolution are provenance fields; resolution is not an accuracy bound, and a horizontal coordinate system does not identify a vertical datum. Service publication dates are not point acquisition dates. The approximate Greylock-area coordinate is not claimed to be the summit. No engineering, hazard or citywide conclusion follows from these five points.

## Catalog and validation

The actual **unconfigured** release catalog has four fixed functions: `arcgis_query`, `arcgis_count`, `arcgis_statistics`, `arcgis_sample`. The notebooks cover **4/4** meaningfully. There are no tables/views/COPY formats in that configuration. Supplying a discovery URL can create data-dependent views/schemas; these notebooks deliberately do not configure one, and do not invent a finite global catalog of every future service. Optional authentication remains part of the four-function surface, though these public examples use none.

Current public baseline `ea7c0f05ae8a75de3d8d235f44d683f5364bcd8c` adds composed example SQL and agent prompts only. Source review confirms unchanged function registration, signatures, processing and root dependencies. Thus current-interface coverage is compatible evidence from the actual release, not a claim of separate current-main binary execution. Full raw catalog/arguments, representative county-layer output columns and the source diff are in [coverage/](coverage/); [coverage.json](coverage.json) links executed SQL to narrative/results.

Validation executes both defaults, detached one-parameter experiments, 24 SQL checks plus population/registry-independent assertions, six overwrite/parameter guards, one fresh compatible Python3.12 kernel with eight libraries preloaded, and visual/output/coverage review. Hosted Colab itself is not manually operated. Source is unchanged and [green CI](https://github.com/Query-farm/vgi-arcgis/actions/runs/43588449279) is reused; no source build, repeated worker test suite or deployment is performed. The [shared standard](STANDARD.md) documents publication behavior.
