/**
 * HTTP for ArcGIS REST endpoints: timeouts, polite retries, ArcGIS error
 * bodies, and a small in-process cache for metadata documents.
 */

import { log, redact } from "./log.ts";
import { VERSION } from "./meta.ts";

export const TIMEOUT_MS = 60_000;
export const MAX_ATTEMPTS = 4;
/** How long service and layer metadata (`?f=json`) stay cached in this process. */
export const METADATA_TTL_MS = 5 * 60_000;
export const USER_AGENT = `vgi-arcgis-worker/${VERSION}`;

/**
 * How a request authenticates (implemented by `ArcgisAuth` in auth.ts). The
 * token is fetched per request and never stored by this module.
 */
export interface RequestAuth {
  /** A non-secret id of the identity (a hash), used in cache keys. */
  readonly id: string;
  /** Whether a rejected (498) token can be replaced by a fresh one. */
  readonly refreshable: boolean;
  /** Extra headers for requests that carry the token (Referer). */
  readonly headers: Record<string, string>;
  /** The token for a request to `url`; a new one when `rejected` is the cached one. */
  token(url: string, rejected?: string): Promise<string>;
  /** What to tell the user when the server answers `code` (498, 499, 401, 403) despite the token. */
  hint(code: number): string;
}

/** Added to auth errors on requests without credentials. */
export const NO_CREDENTIALS_HINT =
  "This service needs an ArcGIS token: ATTACH the catalog with token, username and password, or client_id and " +
  "client_secret (e.g. token getenv('ARCGIS_TOKEN')), or CREATE SECRET (TYPE arcgis, TOKEN ..., SCOPE '<url prefix>') " +
  "for arcgis_query.";

/** The server returned an error we will not retry. */
export class ArcgisError extends Error {
  /** The ArcGIS error code from the response body, or the HTTP status; 0 for network failures. */
  constructor(
    message: string,
    readonly code = 0,
  ) {
    // Messages often quote URLs; never let one carry a token to the user or a log.
    super(redact(message));
  }
}

/** True when the service needs a token or denies access (ArcGIS 498/499, HTTP 401/403). */
export function isAuthError(err: unknown): boolean {
  return err instanceof ArcgisError && AUTH_CODES.includes(err.code);
}

const AUTH_CODES = [401, 403, 498, 499];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True for errors worth another attempt: rate limits and server-side failures. */
function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * GET `url` and decode JSON, with `auth`'s token when given.
 *
 * The token goes in the `token` parameter (with `auth.headers`); a 498
 * (invalid or expired token) from a renewable identity gets one fresh token
 * and one more try. Auth errors say which option or secret to set or check.
 */
export async function getJson(url: string, auth?: RequestAuth | null): Promise<unknown> {
  if (!auth) {
    try {
      return await fetchJson(url);
    } catch (err) {
      if (!isAuthError(err)) throw err;
      throw new ArcgisError(`${(err as Error).message}. ${NO_CREDENTIALS_HINT}`, (err as ArcgisError).code);
    }
  }
  let token = await auth.token(url);
  try {
    return await fetchJson(url, token, auth.headers);
  } catch (err) {
    if (!isAuthError(err)) throw err;
    let failure = err as ArcgisError;
    if (failure.code === 498 && auth.refreshable) {
      log.debug(`GET ${url}: token rejected (498), renewing it once`);
      token = await auth.token(url, token);
      try {
        return await fetchJson(url, token, auth.headers);
      } catch (retryErr) {
        if (!isAuthError(retryErr)) throw retryErr;
        failure = retryErr as ArcgisError;
      }
    }
    throw new ArcgisError(`${failure.message}. ${auth.hint(failure.code)}`, failure.code);
  }
}

/** `url` with the `token` query parameter set. */
function withToken(url: string, token: string): string {
  const u = new URL(url);
  u.searchParams.set("token", token);
  return u.toString();
}

/**
 * GET `url` (plus `token`, if any) and decode JSON.
 *
 * Retries 429, 5xx and network errors with backoff that honours
 * `Retry-After`. ArcGIS reports most failures as HTTP 200 with an
 * `{"error": {...}}` body; those raise `ArcgisError` (server-side 5xx codes in
 * the body are retried like HTTP 5xx).
 */
async function fetchJson(url: string, token?: string, headers?: Record<string, string>): Promise<unknown> {
  // Log and report the URL without the token; only fetch() sees it.
  log.debug(`GET ${url}${token ? " (with token)" : ""}`);
  const target = token ? withToken(url, token) : url;
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(target, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...(token ? headers : {}) },
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

/**
 * `getJson(url, auth)` for metadata, cached for `METADATA_TTL_MS` (failures
 * are not cached). The key includes the identity's hash, so metadata read
 * with one identity is never served to another, or to an anonymous attach.
 */
export function getMetadata(url: string, auth?: RequestAuth | null): Promise<unknown> {
  const key = `${auth?.id ?? "anonymous"} ${url}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < METADATA_TTL_MS) return hit.value;
  const value = getJson(url, auth);
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

/** Forget cached metadata (tests). */
export function clearMetadataCache(): void {
  cache.clear();
}
