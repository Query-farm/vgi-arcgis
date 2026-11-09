/**
 * The worker entry point.
 *
 *   bin/vgi-arcgis-worker                      # stdio: what DuckDB launches by default
 *   bin/vgi-arcgis-worker --http --port 8000   # HTTP: for Docker / hosted deploys
 *   bin/vgi-arcgis-worker --help
 *
 * Attach it from DuckDB:
 *
 *   ATTACH 'arcgis' (TYPE vgi, LOCATION '/abs/path/to/bin/vgi-arcgis-worker');
 *   ATTACH 'arcgis' AS va (TYPE vgi, LOCATION '/abs/path/to/bin/vgi-arcgis-worker',
 *                          url 'https://host/arcgis/rest/services', precision 7);
 */

import { ArcgisCatalog, CATALOG } from "./catalog.ts";
import { serve } from "./cli.ts";
import { CATALOG_DOC_LLM, SOURCE_URL, VERSION } from "./meta.ts";

if (import.meta.main) {
  serve(CATALOG, {
    version: VERSION,
    doc: CATALOG_DOC_LLM,
    repositoryUrl: SOURCE_URL,
    catalogInterface: (_catalog, registry) => new ArcgisCatalog(registry),
  });
}
