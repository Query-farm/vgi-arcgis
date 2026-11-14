# ArcGIS notebooks

[01 · How much of a county is water?](01_county_land_and_water.ipynb) reads all Massachusetts counties from the live public Census TIGERweb county layer. SQL checks completeness, converts area units, compares weighted and unweighted water shares, and tests an inclusive classification cutoff. Embedded outputs show a successful run; the source retrieval time, live vintage description and sorted attribute hash are in the notebook.

## Run from this directory

Requirements: [uv](https://docs.astral.sh/uv/), internet access for the public Census endpoint, and a platform with a published ArcGIS v0.6.0 worker asset (macOS arm64, Linux amd64/arm64, Windows amd64). No credentials are required. Keep the whole `notebooks/` directory together; no worker checkout or build is used.

```sh
cd notebooks
uv sync --locked
uv run --locked python execute.py
```

The environment pins Haybarn 2.0.0rc11 and resolves plotting/Jupyter dependencies in `uv.lock`. To use a notebook editor:

```sh
uv run --locked python -m ipykernel install --user --name vgi-arcgis-notebooks --display-name "Python (vgi-arcgis notebooks)"
```

Select that kernel and use **Restart Kernel → Run All** from this directory. The headless runner creates its own temporary kernel registration and does not need the persistent kernel installation.

## Separate one-parameter experiment

```sh
uv run --locked python execute.py --parameters '{"WATER_SHARE_THRESHOLD": 0.50}' --output-dir artifacts/threshold-50
```

This writes a separate executed notebook with branding, documentation, environment files and runner. Overrides require a separate destination; failed runs leave the last successful default intact. Compare the source hash before interpreting a live rerun as a pure cutoff change. Restore `WATER_SHARE_THRESHOLD = 0.25` for defaults. Generated artifacts and environments are ignored by Git.

## Worker and data provenance

The visible SQL uses the literal `github-auto://Query-farm/vgi-arcgis@v0.6.0`, which Haybarn downloads and caches from [the release](https://github.com/Query-farm/vgi-arcgis/releases/tag/v0.6.0). Upgrade by changing the literal pin, rerunning both default and experiment, and reviewing the API/results; do not silently select a latest release.

The [Census county layer](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1) is queried for state FIPS25 only. Source requests are read-only and materialized once; later analyses reuse that snapshot. Metadata, count and attributes are separate requests, not an atomic service snapshot. [Census area definitions](https://www2.census.gov/geo/pdfs/reference/GARM/Ch15GARM.pdf) explain the land/water distinction. Values are source area attributes in square metres, converted to km²; no geometry-area approximation is used. There is no replay mode or fabricated fallback. A failed source request stops execution.

The threshold is an exploratory rule, not a Census label or a hazard model. The notebook does not infer population, usable land or flood risk.

## SQL credential isolation

The notebook creates Haybarn with a fresh temporary `secret_directory` and
`allow_persistent_secrets=False` before attaching workers. It fully drains and
checks an empty secret inventory. This example needs no saved SQL credential;
its explicit public-data or local-fixture configuration remains in effect.
Cleanup removes the temporary directory after closing the connection.
Existing user SQL secrets are neither read, modified nor deleted.
