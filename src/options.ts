/**
 * ATTACH options and how they travel to every function call.
 *
 *   ATTACH 'arcgis' AS va (TYPE vgi, LOCATION '...',
 *                          url 'https://host/arcgis/rest/services', precision 6);
 *
 * The values are validated in `attach()` and encoded into
 * `attach_opaque_data`, which DuckDB hands back with every catalog and
 * function call, so they survive pooled workers and stateless HTTP.
 */

import { type AttachOptionSpec, int32, utf8 } from "@query-farm/vgi";

export const DEFAULT_PRECISION = 7;
export const MAX_PRECISION = 15;

export const ATTACH_OPTIONS: AttachOptionSpec[] = [
  {
    name: "url",
    description:
      "ArcGIS REST URL to expose as tables: a services directory (.../arcgis/rest/services or a folder), " +
      "a service (.../FeatureServer or .../MapServer) or a single layer (.../FeatureServer/0). " +
      "Omit it to use only the arcgis_query() table function.",
    type: utf8(),
  },
  {
    name: "precision",
    description:
      "Decimal places kept in returned coordinates (ArcGIS geometryPrecision), 0-15. " +
      "7 is about 1 cm in longitude/latitude.",
    type: int32,
    default: DEFAULT_PRECISION,
  },
];

export interface AttachSettings {
  url: string | null;
  precision: number;
}

const ID_BYTES = 16;
const SEP = 0x00;

/** Validate raw ATTACH options. @throws Error naming the bad option. */
export function settingsFromOptions(options: Record<string, unknown>): AttachSettings {
  const rawUrl = options.url;
  const url = rawUrl === undefined || rawUrl === null || rawUrl === "" ? null : String(rawUrl);
  const rawPrecision = options.precision ?? DEFAULT_PRECISION;
  const precision = Number(rawPrecision);
  if (!Number.isInteger(precision) || precision < 0 || precision > MAX_PRECISION) {
    throw new Error(
      `ATTACH option precision must be an integer from 0 to ${MAX_PRECISION}, got ${String(rawPrecision)}`,
    );
  }
  return { url, precision };
}

/** A random per-attach id, a separator, then the settings as JSON. */
export function encodeSettings(settings: AttachSettings): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(settings));
  const out = new Uint8Array(ID_BYTES + 1 + json.byteLength);
  crypto.getRandomValues(out.subarray(0, ID_BYTES));
  out[ID_BYTES] = SEP;
  out.set(json, ID_BYTES + 1);
  return out;
}

/** Settings carried in `attach_opaque_data`; defaults when it carries none. */
export function decodeSettings(data: Uint8Array | null | undefined): AttachSettings {
  if (!data || data.byteLength <= ID_BYTES + 1 || data[ID_BYTES] !== SEP) {
    return { url: null, precision: DEFAULT_PRECISION };
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data.subarray(ID_BYTES + 1))) as Partial<AttachSettings>;
    return {
      url: typeof parsed.url === "string" ? parsed.url : null,
      precision: typeof parsed.precision === "number" ? parsed.precision : DEFAULT_PRECISION,
    };
  } catch {
    return { url: null, precision: DEFAULT_PRECISION };
  }
}
