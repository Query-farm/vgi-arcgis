/**
 * The catalog DuckDB attaches.
 *
 * `main` always holds `arcgis_query(url)`. With an ATTACH `url`, the catalog
 * also lists views over the ArcGIS layers it finds there (see discovery.ts),
 * resolved lazily: a services directory's per-service schemas are listed at
 * attach, and each schema's views are fetched when DuckDB first asks.
 */

import {
  type AttachOpaqueData,
  type CatalogAttachResult,
  type CatalogDescriptor,
  type FunctionRegistry,
  ReadOnlyCatalogInterface,
  type SchemaInfo,
  type TransactionOpaqueData,
  type VgiFunction,
  type ViewInfo,
} from "@query-farm/vgi";
import { type DiscoveredView, directorySchemas, mainViews, serviceViews } from "./discovery.ts";
import { classifyUrl } from "./esri.ts";
import { CATALOG_DOC_MD, CATALOG_NAME, CATALOG_TAGS, SCHEMA_DOC_MD, SCHEMA_TAGS, SOURCE_URL } from "./meta.ts";
import { ATTACH_OPTIONS, decodeSettings, encodeSettings, settingsFromOptions } from "./options.ts";
import { arcgisQuery } from "./query.ts";

export const FUNCTIONS: VgiFunction[] = [arcgisQuery];

interface Example {
  description: string;
  sql: string;
}

/** Publish each function's examples as `vgi.example_queries`; returns them all for the schema. */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const all: Example[] = [];
  for (const fn of functions) {
    const examples = (fn.meta.examples ?? []).map((ex) => ({ description: ex.description, sql: ex.sql }));
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(examples) };
    all.push(...examples);
  }
  return all;
}

const ALL_EXAMPLES = stampExampleQueries(FUNCTIONS);

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_DOC_MD,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  attachOptions: ATTACH_OPTIONS,
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_DOC_MD,
      functions: FUNCTIONS,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(ALL_EXAMPLES) },
    },
  ],
};

const isMain = (path: string[]) => path.length === 1 && path[0]?.toLowerCase() === "main";

function toViewInfo(v: DiscoveredView, path: string[]): ViewInfo {
  return {
    name: v.name,
    schema_path: path,
    comment: v.comment,
    tags: {
      "arcgis.layer_url": v.layerUrl,
      "arcgis.layer_id": String(v.layerId),
      "arcgis.layer_path": v.layerPath.join(" > "),
    },
    definition: v.definition,
    column_comments: v.hasGeometry
      ? {
          geometry:
            "Feature geometry in WGS84 longitude/latitude. Spatial filters against a constant run on the server.",
        }
      : {},
    aliases: [],
    security: "regular",
  } as ViewInfo;
}

export class ArcgisCatalog extends ReadOnlyCatalogInterface {
  // Contents depend on the ATTACH url: never share them between attaches, and
  // let DuckDB fetch each schema's views on demand.
  override perAttachItemIds = true;
  override catalogContentsAttachIndependent = false;
  override supportsCatalogContents = false;

  constructor(registry: FunctionRegistry) {
    super(CATALOG, registry, { perAttachItemIds: true });
  }

  override attach(
    name: string,
    options?: Record<string, unknown>,
    dataVersionSpec?: string | null,
    implementationVersion?: string | null,
    clientCapabilities?: Uint8Array | null,
  ): CatalogAttachResult {
    const settings = settingsFromOptions(options ?? {});
    if (settings.url) settings.url = classifyUrl(settings.url).url; // validate early, store normalized
    const base = super.attach(name, options, dataVersionSpec, implementationVersion, clientCapabilities);
    return { ...(base as CatalogAttachResult), attach_opaque_data: encodeSettings(settings) };
  }

  /** `main` (functions, plus views for a service/layer url) and one schema per service for a directory url. */
  override async schemas(attach: AttachOpaqueData, txn?: TransactionOpaqueData): Promise<SchemaInfo[]> {
    const base = await super.schemas(attach, txn);
    const { url } = decodeSettings(attach);
    if (!url) return base;
    const unknownViews = (info: SchemaInfo): SchemaInfo => {
      // Leave the view count out: "unknown" makes DuckDB ask for the views.
      const { view: _view, ...counts } = (info.estimated_object_count ?? {}) as Record<string, number>;
      return { ...info, estimated_object_count: counts };
    };
    const target = classifyUrl(url);
    if (target.kind !== "directory") return base.map(unknownViews);
    const discovered = await directorySchemas(target.url);
    return [
      ...base,
      ...discovered.map((s) =>
        unknownViews({
          path: [s.name],
          comment: s.comment,
          tags: { "arcgis.service_url": s.serviceUrl },
          estimated_object_count: {
            table: 0,
            scalar_function: 0,
            aggregate_function: 0,
            table_function: 0,
            macro: 0,
            index: 0,
          },
        } as SchemaInfo),
      ),
    ];
  }

  override async schemaGet(
    attach: AttachOpaqueData,
    path: string[],
    txn?: TransactionOpaqueData,
  ): Promise<SchemaInfo | null> {
    const all = await this.schemas(attach, txn);
    return (
      all.find(
        (s) => s.path.length === path.length && s.path.every((p, i) => p.toLowerCase() === path[i]?.toLowerCase()),
      ) ?? null
    );
  }

  override async schemaContentsViews(
    attach: AttachOpaqueData,
    path: string[],
    _txn?: TransactionOpaqueData,
  ): Promise<ViewInfo[]> {
    const { url } = decodeSettings(attach);
    if (!url) return [];
    if (isMain(path)) return (await mainViews(url)).map((v) => toViewInfo(v, path));
    const target = classifyUrl(url);
    if (target.kind !== "directory") return [];
    const schema = (await directorySchemas(target.url)).find((s) => s.name === path[0]?.toLowerCase());
    if (!schema || path.length !== 1) return [];
    return (await serviceViews(schema.serviceUrl)).map((v) => toViewInfo(v, path));
  }

  override async viewGet(
    attach: AttachOpaqueData,
    path: string[],
    name: string,
    txn?: TransactionOpaqueData,
  ): Promise<ViewInfo | null> {
    const views = await this.schemaContentsViews(attach, path, txn);
    return views.find((v) => v.name === name.toLowerCase()) ?? null;
  }
}
