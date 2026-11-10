/**
 * Token-secured ArcGIS services: credentials, token acquisition and the
 * `arcgis` DuckDB secret type.
 *
 * Credentials come from two places, in this order:
 *
 * 1. ATTACH options `token`, `username` + `password` or `client_id` +
 *    `client_secret` (declared `secret: true`, so the SDK carries them
 *    encrypted in `attach_opaque_data` and `attachOptions()` reads them
 *    back). They apply to URLs on the same origin as the ATTACH `url`, or to
 *    every URL when the catalog was attached without one.
 * 2. A `CREATE SECRET (TYPE arcgis, ..., SCOPE '<url prefix>')`, which
 *    `arcgis_query` asks DuckDB for per layer URL (longest scope wins).
 *    Catalog hooks (directory listing, views) get no secrets, only ATTACH
 *    options.
 *
 * A `token` is used as is. A username/password is exchanged at the server's
 * token service (`<server>/rest/info` -> `authInfo.tokenServicesUrl`), and a
 * client_id/client_secret at the portal's `/sharing/rest/oauth2/token`.
 * Generated tokens live in this process's memory only, keyed by the token
 * endpoint and a hash of the identity, and are renewed before they expire
 * and once more when the server answers 498. They never go into
 * table-function state: every call re-derives them from its attach options
 * or secrets.
 */

import { createHash } from "node:crypto";
import {
  attachOptions,
  field,
  type SecretsDict,
  type SecretTypeDescriptor,
  schema,
  secretForScopeOfType,
  utf8,
} from "@query-farm/vgi";
import { classifyUrl } from "./esri.ts";
import { ArcgisError, getMetadata, type RequestAuth, TIMEOUT_MS, USER_AGENT } from "./http.ts";
import { log } from "./log.ts";
import { decodeSettings } from "./options.ts";

/** The DuckDB secret type the catalog declares. */
export const SECRET_TYPE = "arcgis";

/** Sent as `referer` when generating a token, and as the Referer header on requests that carry one. */
export const REFERER = "https://github.com/Query-farm/vgi-arcgis";

/** Lifetime requested for generated tokens, in minutes. */
export const TOKEN_MINUTES = 60;

/** Renew a generated token this long before it expires (at most half its lifetime). */
export const TOKEN_MARGIN_MS = 2 * 60_000;

/** ArcGIS Online's portal, for hosted services (`services*.arcgis.com`). */
export const ARCGIS_ONLINE_PORTAL = "https://www.arcgis.com/sharing/rest";

export type Credentials =
  | { kind: "token"; token: string }
  | { kind: "password"; username: string; password: string }
  | { kind: "client"; clientId: string; clientSecret: string };

/** The ATTACH options (and secret fields) that carry credentials. */
export const CREDENTIAL_KEYS = ["token", "username", "password", "client_id", "client_secret"] as const;

function lookup(values: Readonly<Record<string, unknown>>, name: string): string | undefined {
  let v: unknown = values[name];
  if (v === undefined) {
    const key = Object.keys(values).find((k) => k.toLowerCase() === name);
    v = key === undefined ? undefined : values[key];
  }
  if (v === null || v === undefined) return undefined;
  const s = String(v);
  return s.trim() === "" ? undefined : s;
}

/**
 * Credentials from ATTACH options or secret fields, or null when none are set.
 *
 * @param what names the source in errors, e.g. "ATTACH option" or "arcgis secret 'x':".
 * @throws Error for an incomplete or ambiguous combination (never quoting a value).
 */
export function credentialsFrom(values: Readonly<Record<string, unknown>>, what: string): Credentials | null {
  const token = lookup(values, "token");
  const username = lookup(values, "username");
  const password = lookup(values, "password");
  const clientId = lookup(values, "client_id");
  const clientSecret = lookup(values, "client_secret");
  const given = [
    token !== undefined && "token",
    (username !== undefined || password !== undefined) && "username/password",
    (clientId !== undefined || clientSecret !== undefined) && "client_id/client_secret",
  ].filter((g): g is string => Boolean(g));
  if (given.length === 0) return null;
  if (given.length > 1) {
    throw new Error(
      `${what} ${given.join(" and ")} cannot be combined: give either token, or username and password, ` +
        "or client_id and client_secret",
    );
  }
  if (token !== undefined) return { kind: "token", token };
  if (username !== undefined || password !== undefined) {
    if (username === undefined) throw new Error(`${what} password needs username as well`);
    if (password === undefined) throw new Error(`${what} username needs password as well`);
    return { kind: "password", username, password };
  }
  if (clientId === undefined) throw new Error(`${what} client_secret needs client_id as well`);
  if (clientSecret === undefined) throw new Error(`${what} client_id needs client_secret as well`);
  return { kind: "client", clientId, clientSecret };
}

/** A short, stable, non-reversible id for an identity: safe in cache keys and logs. */
export function identityId(creds: Credentials | null): string {
  if (!creds) return "anonymous";
  const parts =
    creds.kind === "token"
      ? [creds.token]
      : creds.kind === "password"
        ? [creds.username, creds.password]
        : [creds.clientId, creds.clientSecret];
  const hash = createHash("sha256")
    .update(["vgi-arcgis", creds.kind, ...parts].join("\0"))
    .digest("hex");
  return `${creds.kind}:${hash.slice(0, 24)}`;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Refuse to send a credential over plain HTTP, except to this machine.
 *
 * @throws Error naming the origin.
 */
export function assertSecureTransport(url: string, what: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not a valid URL: '${url}'`);
  }
  if (u.protocol === "https:") return;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return;
  throw new Error(`refusing to send ${what} to ${u.origin} without TLS; use an https:// URL`);
}

const isArcgisOnline = (url: string): boolean => /(^|\.)arcgis\.com$/i.test(new URL(url).hostname);

/** `<server>/rest/info?f=json` for a URL under `<server>/rest/services`. @throws Error otherwise. */
export function serverInfoUrl(url: string): string {
  const m = url.match(/^(https?:\/\/.+?\/rest)\/services(?:[/?#]|$)/i);
  if (!m) {
    throw new Error(
      `cannot find the ArcGIS Server behind '${url}' (expected a URL under .../rest/services) to obtain a token; ` +
        "pass a pre-generated token instead",
    );
  }
  return `${m[1]}/info?f=json`;
}

interface ServerInfo {
  owningSystemUrl?: string;
  authInfo?: { isTokenBasedSecurity?: boolean; tokenServicesUrl?: string };
}

/** The portal's `/sharing/rest` root that owns a token service URL, if it is one. */
export function portalRoot(tokenServicesUrl: string | undefined, owningSystemUrl?: string): string | undefined {
  const m = tokenServicesUrl?.match(/^(https?:\/\/.+?\/sharing)(?:\/rest)?(?:\/|$)/i);
  if (m) return `${m[1]}/rest`;
  if (owningSystemUrl) return `${owningSystemUrl.replace(/\/+$/, "")}/sharing/rest`;
  return undefined;
}

/**
 * Where to exchange `kind` credentials for a token for requests to `url`:
 * the server's generateToken (username/password) or its portal's
 * oauth2/token (client credentials).
 */
export async function tokenEndpoint(url: string, kind: "password" | "client"): Promise<string> {
  const infoUrl = serverInfoUrl(url);
  const online = isArcgisOnline(url);
  let info: ServerInfo = {};
  try {
    info = (await getMetadata(infoUrl)) as ServerInfo;
  } catch (err) {
    if (!online) {
      throw new ArcgisError(
        `could not read the token service of ${infoUrl.replace(/\?.*$/, "")}: ${(err as Error).message}`,
        err instanceof ArcgisError ? err.code : 0,
      );
    }
  }
  const raw = info.authInfo?.tokenServicesUrl || (online ? `${ARCGIS_ONLINE_PORTAL}/generateToken` : undefined);
  const tokenServices = raw ? new URL(raw, infoUrl).toString() : undefined;
  if (kind === "password") {
    if (!tokenServices) {
      throw new Error(
        `${infoUrl.replace(/\/info\?.*$/, "")} advertises no token service (authInfo.tokenServicesUrl): it may ` +
          "use web-tier authentication (IWA/PKI), which is not supported; pass a pre-generated token instead",
      );
    }
    return tokenServices;
  }
  const portal = portalRoot(tokenServices, info.owningSystemUrl) ?? (online ? ARCGIS_ONLINE_PORTAL : undefined);
  if (!portal) {
    throw new Error(
      `client_id/client_secret need ArcGIS Online or an ArcGIS Enterprise portal, but ` +
        `${infoUrl.replace(/\/info\?.*$/, "")} uses a standalone token service; use username and password, ` +
        "or a token, instead",
    );
  }
  return `${portal}/oauth2/token`;
}

// ------------------------------------------------------------ token cache

interface IssuedToken {
  token: string;
  /** Epoch ms after which the token is renewed (its expiry less the margin). */
  renewAt: number;
}

const issued = new Map<string, Promise<IssuedToken>>();
let clock: () => number = Date.now;

/** Replace the clock (tests); returns the previous one. */
export function setClock(fn: () => number): () => number {
  const prev = clock;
  clock = fn;
  return prev;
}

/** Forget every generated token (tests). */
export function clearTokenCache(): void {
  issued.clear();
}

/** When to renew a token that expires at `expiresAt`, issued now. */
export function renewAt(expiresAt: number, issuedAt: number): number {
  return expiresAt - Math.min(TOKEN_MARGIN_MS, Math.max(0, expiresAt - issuedAt) / 2);
}

async function settle(p: Promise<IssuedToken> | undefined): Promise<IssuedToken | null> {
  if (!p) return null;
  try {
    return await p;
  } catch {
    return null;
  }
}

/** POST a form and decode JSON; retries 429, 5xx and network errors twice. Never logs the body. */
async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  log.debug(`POST ${url}`);
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
          Referer: REFERER,
        },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= 3) throw new ArcgisError(`POST ${url} failed: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await response.body?.cancel();
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        continue;
      }
      await response.body?.cancel();
      throw new ArcgisError(`POST ${url} failed with HTTP ${response.status}`, response.status);
    }
    const body = (await response.json()) as Record<string, unknown>;
    const error = body?.error as
      | { code?: number; message?: string; error_description?: string; details?: unknown }
      | string
      | undefined;
    if (error) {
      if (typeof error === "string") {
        throw new ArcgisError(`${error}${body.error_description ? `: ${body.error_description}` : ""}`, 400);
      }
      const details = Array.isArray(error.details) && error.details.length ? ` ${error.details.join(" ")}` : "";
      throw new ArcgisError(
        `${error.message ?? error.error_description ?? "unknown error"}${details}`,
        Number(error.code ?? 0),
      );
    }
    return body;
  }
}

/** Exchange credentials for a token at `endpoint`. */
async function issueToken(endpoint: string, creds: Credentials, source: string): Promise<IssuedToken> {
  if (creds.kind === "token") return { token: creds.token, renewAt: Number.POSITIVE_INFINITY };
  const what = creds.kind === "password" ? "a password" : "a client secret";
  assertSecureTransport(endpoint, what);
  const started = clock();
  let body: Record<string, unknown>;
  try {
    body =
      creds.kind === "password"
        ? await postForm(endpoint, {
            username: creds.username,
            password: creds.password,
            client: "referer",
            referer: REFERER,
            expiration: String(TOKEN_MINUTES),
            f: "json",
          })
        : await postForm(endpoint, {
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            grant_type: "client_credentials",
            expiration: String(TOKEN_MINUTES),
            f: "json",
          });
  } catch (err) {
    throw new ArcgisError(
      `could not get an ArcGIS token from ${endpoint} with ${source}: ${(err as Error).message.replace(/\.+$/, "")}. ` +
        `Check ${source}.`,
      err instanceof ArcgisError ? err.code : 0,
    );
  }
  const token = creds.kind === "password" ? body.token : body.access_token;
  if (typeof token !== "string" || token === "") {
    throw new ArcgisError(`the token service ${endpoint} returned no token for ${source}`);
  }
  const expiresAt =
    creds.kind === "password"
      ? Number(body.expires) || started + TOKEN_MINUTES * 60_000
      : started + (Number(body.expires_in) || TOKEN_MINUTES * 60) * 1000;
  log.debug(`got an ArcGIS token from ${endpoint} (${creds.kind}), expires ${new Date(expiresAt).toISOString()}`);
  return { token, renewAt: renewAt(expiresAt, started) };
}

/**
 * A token from `endpoint` for `creds`: the cached one while it is fresh and
 * not `rejected` by the server, else a new one. Concurrent callers share a
 * request.
 */
export async function cachedToken(
  endpoint: string,
  creds: Credentials,
  source: string,
  rejected?: string,
): Promise<string> {
  const key = `${endpoint}\n${identityId(creds)}`;
  const usable = (t: IssuedToken | null): t is IssuedToken => t !== null && t.token !== rejected && clock() < t.renewAt;
  const current = issued.get(key);
  const hit = await settle(current);
  if (usable(hit)) return hit.token;
  const latest = issued.get(key);
  if (latest && latest !== current) {
    // Another caller renewed it meanwhile.
    const renewed = await settle(latest);
    if (usable(renewed)) return renewed.token;
  }
  const next = issueToken(endpoint, creds, source);
  issued.set(key, next);
  next.catch(() => {
    if (issued.get(key) === next) issued.delete(key);
  });
  return (await next).token;
}

// --------------------------------------------------------- request auth

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function describeSource(creds: Credentials, origin: "attach" | string): string {
  const names =
    creds.kind === "token"
      ? "token"
      : creds.kind === "password"
        ? "username and password"
        : "client_id and client_secret";
  if (origin === "attach") return `the ATTACH option${creds.kind === "token" ? "" : "s"} ${names}`;
  return `the ${names.toUpperCase()} of the arcgis secret '${origin}'`;
}

/** Credentials bound to one source; what http.ts's getJson uses to sign requests. */
export class ArcgisAuth implements RequestAuth {
  readonly id: string;
  readonly refreshable: boolean;
  readonly headers: Record<string, string> = { Referer: REFERER };
  readonly source: string;

  /** @param origin "attach", or the DuckDB name of the secret the credentials came from. */
  constructor(
    readonly creds: Credentials,
    origin: "attach" | string,
  ) {
    this.id = identityId(creds);
    this.refreshable = creds.kind !== "token";
    this.source = describeSource(creds, origin);
  }

  async token(url: string, rejected?: string): Promise<string> {
    assertSecureTransport(url, "an ArcGIS token");
    if (this.creds.kind === "token") return this.creds.token;
    const endpoint = await tokenEndpoint(url, this.creds.kind);
    return cachedToken(endpoint, this.creds, this.source, rejected);
  }

  hint(code: number): string {
    if (code === 498) {
      return this.refreshable
        ? `ArcGIS rejected the token generated with ${this.source}, even after renewing it.`
        : `${capitalize(this.source)} is invalid or has expired: generate a new token, or use username and ` +
            "password or client_id and client_secret, which renew automatically.";
    }
    if (code === 499) {
      return `The server asked for a token although one from ${this.source} was sent: check that it was issued by this server's token service (its /rest/info).`;
    }
    return `The ArcGIS identity from ${this.source} has no access to this resource.`;
  }
}

/** Do ATTACH credentials apply to `url`? Same origin as the ATTACH url, or any url without one. */
export function attachCredentialsApply(attachUrl: string | null, url: string): boolean {
  if (!attachUrl) return true;
  try {
    return new URL(attachUrl).origin === new URL(url).origin;
  } catch {
    return false;
  }
}

/** The attach's credentials (validated at ATTACH), if any; ignores bytes the SDK did not hand out. */
export function attachCredentials(attach: Uint8Array | null | undefined): Credentials | null {
  let options: Readonly<Record<string, unknown>>;
  try {
    options = attachOptions(attach);
  } catch {
    return null;
  }
  return credentialsFrom(options, "ATTACH option");
}

/** Auth from the ATTACH options for a request to `url`, or null. */
export function attachAuth(attach: Uint8Array | null | undefined, url: string): ArcgisAuth | null {
  const creds = attachCredentials(attach);
  if (!creds || !attachCredentialsApply(decodeSettings(attach).url, url)) return null;
  return new ArcgisAuth(creds, "attach");
}

/** Auth from the `arcgis` secret whose SCOPE best matches `url`, or null. */
export function secretAuth(secrets: SecretsDict | undefined, url: string): ArcgisAuth | null {
  const secret = secretForScopeOfType(secrets ?? {}, url, SECRET_TYPE);
  if (!secret) return null;
  const name = String(secret.name ?? SECRET_TYPE);
  const creds = credentialsFrom(secret, `arcgis secret '${name}':`);
  if (!creds) {
    throw new Error(
      `the arcgis secret '${name}' holds no credentials: set TOKEN, or USERNAME and PASSWORD, or CLIENT_ID and CLIENT_SECRET`,
    );
  }
  return new ArcgisAuth(creds, name);
}

/** ATTACH credentials first, then a scoped `arcgis` secret, else anonymous (null). */
export function resolveAuth(
  attach: Uint8Array | null | undefined,
  secrets: SecretsDict | undefined,
  url: string,
): ArcgisAuth | null {
  return attachAuth(attach, url) ?? secretAuth(secrets, url);
}

/**
 * What a table function's first bind returns to have DuckDB resolve the
 * `arcgis` secret for `url`; null once secrets were resolved, or when ATTACH
 * credentials already apply.
 */
export function secretLookup(
  attach: Uint8Array | null | undefined,
  url: string,
  resolvedSecretsProvided: boolean,
): { lookupSecretTypes: string[]; lookupScopes: string[] } | null {
  if (resolvedSecretsProvided || attachAuth(attach, url)) return null;
  let scope = url;
  try {
    scope = classifyUrl(url).url;
  } catch {
    // An invalid URL fails at the real bind with a better message.
  }
  return { lookupSecretTypes: [SECRET_TYPE], lookupScopes: [scope] };
}

// ------------------------------------------------------------ secret type

const secretField = (name: string, doc: string, redact: boolean) =>
  field(name, utf8(), true, new Map([["vgi_doc", doc], ...(redact ? [["redact", "true"] as [string, string]] : [])]));

/** `CREATE SECRET (TYPE arcgis, ...)`, registered by the catalog at ATTACH. */
export const ARCGIS_SECRET_TYPE: SecretTypeDescriptor = {
  name: SECRET_TYPE,
  description:
    "Credentials for token-secured ArcGIS REST services (ArcGIS Server, ArcGIS Enterprise and ArcGIS Online) " +
    "read by arcgis_query: a pre-generated ArcGIS token, an ArcGIS username and password, or an ArcGIS OAuth " +
    "app's client_id and client_secret. Give it a SCOPE (a URL prefix such as " +
    "'https://host/arcgis/rest/services/') so it is only sent to that server; the longest matching scope wins.",
  schema: schema(
    [
      secretField(
        "token",
        "A pre-generated ArcGIS token (from the server's generateToken page, or an ArcGIS Online API key), " +
          "sent as the token parameter as is. Generate it with client=requestip, or with referer " +
          `${REFERER}. It is not renewed when it expires.`,
        true,
      ),
      secretField(
        "username",
        "ArcGIS Server, ArcGIS Enterprise or ArcGIS Online user name; exchanged with password for a token at " +
          "the server's token service (authInfo.tokenServicesUrl of <server>/rest/info).",
        false,
      ),
      secretField("password", "Password of username. Sent only to the server's token service, over HTTPS.", true),
      secretField(
        "client_id",
        "Client ID of an ArcGIS OAuth application (ArcGIS Online or an ArcGIS Enterprise portal: Content > " +
          "the app item > Settings), used with client_secret for the client-credentials flow.",
        false,
      ),
      secretField(
        "client_secret",
        "Client secret of the OAuth application named by client_id. Sent only to the portal's oauth2/token " +
          "endpoint, over HTTPS.",
        true,
      ),
    ],
    new Map([["vgi_doc_url", "https://developers.arcgis.com/documentation/security-and-authentication/"]]),
  ),
};
