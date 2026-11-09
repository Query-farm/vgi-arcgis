/**
 * HTTP for ArcGIS REST endpoints: timeouts, polite retries, ArcGIS error
 * bodies, and a small in-process cache for metadata documents.
 */

import { log } from "./log.ts";
import { VERSION } from "./meta.ts";

export const TIMEOUT_MS = 60_000;
export const MAX_ATTEMPTS = 4;
/** How long service and layer metadata (`?f=json`) stay cached in this process. */
export const METADATA_TTL_MS = 5 * 60_000;
const USER_AGENT = `vgi-arcgis-worker/${VERSION}`;

/** The server returned an error we will not retry. */
export class ArcgisError extends Error {
  /** The ArcGIS error code from the response body, or the HTTP status; 0 for network failures. */
  constructor(
    message: string,
    readonly code = 0,
  ) {
    super(message);
  }
}

/** True when the service needs a token or denies access (ArcGIS 498/499, HTTP 401/403). */
export function isAuthError(err: unknown): boolean {
  return err instanceof ArcgisError && [401, 403, 498, 499].includes(err.code);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True for errors worth another attempt: rate limits and server-side failures. */
function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * GET `url` and decode JSON.
 *
 * Retries 429, 5xx and network errors with backoff that honours
 * `Retry-After`. ArcGIS reports most failures as HTTP 200 with an
 * `{"error": {...}}` body; those raise `ArcgisError` (server-side 5xx codes in
 * the body are retried like HTTP 5xx).
 */
export async function getJson(url: string): Promise<unknown> {
  log.debug(`GET ${url}`);
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new ArcgisError(`GET ${url} failed: ${(err as Error).message}`);
      await sleep(250 * 2 ** attempt);
      continue;
    }
    if (!response.ok) {
      if (!retryable(response.status) || attempt >= MAX_ATTEMPTS) {
        const body = (await response.text()).slice(0, 300);
        throw new ArcgisError(`GET ${url} failed with HTTP ${response.status}: ${body}`, response.status);
      }
      await response.body?.cancel();
      const retryAfter = response.headers.get("Retry-After");
      const delay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 250 * 2 ** attempt;
      log.debug(`GET ${url}: HTTP ${response.status}, retrying in ${delay} ms`);
      await sleep(Math.min(delay, 30_000));
      continue;
    }
    const body = (await response.json()) as { error?: { code?: number; message?: string; details?: unknown } };
    if (body && typeof body === "object" && body.error) {
      const code = Number(body.error.code ?? 0);
      if (retryable(code) && attempt < MAX_ATTEMPTS) {
        await sleep(250 * 2 ** attempt);
        continue;
      }
      const details = Array.isArray(body.error.details) && body.error.details.length ? ` ${body.error.details}` : "";
      throw new ArcgisError(
        `ArcGIS error ${code} from ${url}: ${body.error.message ?? "unknown error"}${details}`,
        code,
      );
    }
    return body;
  }
}

const cache = new Map<string, { at: number; value: Promise<unknown> }>();

/** `getJson(url)` for metadata, cached for `METADATA_TTL_MS` (failures are not cached). */
export function getMetadata(url: string): Promise<unknown> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < METADATA_TTL_MS) return hit.value;
  const value = getJson(url);
  cache.set(url, { at: Date.now(), value });
  value.catch(() => cache.delete(url));
  return value;
}

/** Forget cached metadata (tests). */
export function clearMetadataCache(): void {
  cache.clear();
}
