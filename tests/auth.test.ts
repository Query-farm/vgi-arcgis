// Unit tests for token-secured services (src/auth.ts and its hooks in http.ts).
// Every credential here is fake; the mock server (test/mock_api/server.py) accepts them.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Arguments, VgiClient } from "@query-farm/vgi";
import { subprocessConnect } from "@query-farm/vgi-rpc";
import {
  ArcgisAuth,
  assertSecureTransport,
  attachCredentialsApply,
  clearTokenCache,
  credentialsFrom,
  identityId,
  portalRoot,
  renewAt,
  secretAuth,
  secretLookup,
  serverInfoUrl,
  setClock,
  TOKEN_MARGIN_MS,
  tokenEndpoint,
} from "../src/auth.ts";
import { clearMetadataCache, getJson, getMetadata } from "../src/http.ts";
import { redact } from "../src/log.ts";

const ROOT = join(import.meta.dir, "..");
const USER = { username: "test-user", password: "not-a-real-password" };
const APP = { client_id: "test-client-id", client_secret: "not-a-real-client-secret" };

// ------------------------------------------------------------- pure helpers

describe("credentialsFrom", () => {
  test("one kind of credential, complete", () => {
    expect(credentialsFrom({}, "ATTACH option")).toBeNull();
    expect(credentialsFrom({ url: "x", token: null, username: "" }, "ATTACH option")).toBeNull();
    expect(credentialsFrom({ token: "fake-static-token" }, "ATTACH option")).toEqual({
      kind: "token",
      token: "fake-static-token",
    });
    expect(credentialsFrom(USER, "ATTACH option")).toEqual({ kind: "password", ...USER });
    expect(credentialsFrom({ CLIENT_ID: "a", Client_Secret: "b" }, "ATTACH option")).toEqual({
      kind: "client",
      clientId: "a",
      clientSecret: "b",
    });
  });

  test("incomplete or mixed credentials fail without quoting values", () => {
    expect(() => credentialsFrom({ username: "u" }, "ATTACH option")).toThrow("username needs password");
    expect(() => credentialsFrom({ password: "not-a-real-password" }, "ATTACH option")).toThrow(
      "password needs username",
    );
    expect(() => credentialsFrom({ client_id: "a" }, "ATTACH option")).toThrow("client_id needs client_secret");
    expect(() => credentialsFrom({ client_secret: "b" }, "ATTACH option")).toThrow("client_secret needs client_id");
    let message = "";
    try {
      credentialsFrom({ token: "fake-static-token", ...USER }, "ATTACH option");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/token and username\/password cannot be combined/);
    expect(message).not.toContain("fake-static-token");
    expect(message).not.toContain("not-a-real-password");
  });
});

describe("redaction and identity", () => {
  test("redact hides credential parameters and JSON values", () => {
    expect(redact("GET https://h/x/query?where=1%3D1&token=abc.def-123&f=json")).toBe(
      "GET https://h/x/query?where=1%3D1&token=<redacted>&f=json",
    );
    expect(redact("https://h/x?token=abc")).toBe("https://h/x?token=<redacted>");
    expect(redact("password=hunter2&username=u client_secret=s access_token=t")).toBe(
      "password=<redacted>&username=u client_secret=<redacted> access_token=<redacted>",
    );
    expect(redact('{"token": "abc", "expires": 1, "access_token":"t"}')).toBe(
      '{"token": "<redacted>", "expires": 1, "access_token":"<redacted>"}',
    );
    // Not credentials: left alone.
    expect(redact("tokenServicesUrl=https://h/x")).toBe("tokenServicesUrl=https://h/x");
  });

  test("identityId is stable, distinct and never contains the secret", () => {
    const a = identityId({ kind: "token", token: "fake-static-token" });
    expect(a).toBe(identityId({ kind: "token", token: "fake-static-token" }));
    expect(a).not.toBe(identityId({ kind: "token", token: "fake-expired-token" }));
    expect(a).not.toContain("fake");
    const pw = identityId({ kind: "password", ...USER });
    expect(pw).not.toBe(identityId({ kind: "password", username: "test-user", password: "other" }));
    expect(pw).not.toContain("test-user");
    expect(identityId(null)).toBe("anonymous");
  });
});

describe("token endpoints and scoping", () => {
  test("serverInfoUrl and portalRoot", () => {
    expect(serverInfoUrl("https://h/arcgis/rest/services/A/FeatureServer/0")).toBe("https://h/arcgis/rest/info?f=json");
    expect(serverInfoUrl("https://services.arcgis.com/Org1/arcgis/rest/services/X/FeatureServer/0")).toBe(
      "https://services.arcgis.com/Org1/arcgis/rest/info?f=json",
    );
    expect(() => serverInfoUrl("https://hub.example.gov/datasets/x")).toThrow(/rest\/services/);
    expect(portalRoot("https://p.example.gov/portal/sharing/rest/generateToken")).toBe(
      "https://p.example.gov/portal/sharing/rest",
    );
    expect(portalRoot("https://www.arcgis.com/sharing/generateToken")).toBe("https://www.arcgis.com/sharing/rest");
    expect(portalRoot("https://h/arcgis/tokens/generateToken")).toBeUndefined();
    expect(portalRoot("https://h/arcgis/tokens/generateToken", "https://p.example.gov/portal/")).toBe(
      "https://p.example.gov/portal/sharing/rest",
    );
  });

  test("credentials never travel without TLS, except to this machine", () => {
    expect(() => assertSecureTransport("https://h/x", "a password")).not.toThrow();
    expect(() => assertSecureTransport("http://127.0.0.1:9/x", "a password")).not.toThrow();
    expect(() => assertSecureTransport("http://localhost/x", "a password")).not.toThrow();
    expect(() => assertSecureTransport("http://gis.example.gov/x", "a password")).toThrow(/without TLS/);
  });

  test("ATTACH credentials apply to the ATTACH url's origin only", () => {
    expect(attachCredentialsApply(null, "https://any/x/FeatureServer/0")).toBe(true);
    expect(
      attachCredentialsApply("https://a.gov/arcgis/rest/services", "https://a.gov/arcgis/rest/services/S/MapServer/1"),
    ).toBe(true);
    expect(
      attachCredentialsApply("https://a.gov/arcgis/rest/services", "https://b.gov/arcgis/rest/services/S/MapServer/1"),
    ).toBe(false);
    expect(
      attachCredentialsApply("https://a.gov/arcgis/rest/services", "http://a.gov/arcgis/rest/services/S/MapServer/1"),
    ).toBe(false);
  });

  test("secrets: longest scope wins; first bind asks for the URL's scope", () => {
    const secrets = {
      wide: { type: "arcgis", name: "wide", scope: "https://h/arcgis/rest/services/", token: "fake-static-token" },
      narrow: {
        type: "arcgis",
        name: "narrow",
        scope: "https://h/arcgis/rest/services/S/FeatureServer/0",
        ...USER,
      },
      other: { type: "s3", name: "other", scope: "", key_id: "x" },
    };
    expect(secretAuth(secrets, "https://h/arcgis/rest/services/S/FeatureServer/0")?.creds.kind).toBe("password");
    expect(secretAuth(secrets, "https://h/arcgis/rest/services/T/FeatureServer/0")?.creds.kind).toBe("token");
    expect(secretAuth(secrets, "https://elsewhere/arcgis/rest/services/T/FeatureServer/0")).toBeNull();
    expect(secretAuth({}, "https://h/x")).toBeNull();
    expect(() => secretAuth({ e: { type: "arcgis", name: "e", scope: "" } }, "https://h/x")).toThrow(
      /holds no credentials/,
    );
    expect(secretLookup(null, "https://h/arcgis/rest/services/S/FeatureServer/0/?f=json", false)).toEqual({
      lookupSecretTypes: ["arcgis"],
      lookupScopes: ["https://h/arcgis/rest/services/S/FeatureServer/0"],
    });
    expect(secretLookup(null, "https://h/x", true)).toBeNull();
  });

  test("renewAt keeps a margin, at most half the lifetime", () => {
    expect(renewAt(60 * 60_000, 0)).toBe(60 * 60_000 - TOKEN_MARGIN_MS);
    expect(renewAt(60_000, 0)).toBe(30_000);
    expect(renewAt(0, 10)).toBe(0);
  });
});

// ------------------------------------------------- against the mock server

async function startMock(): Promise<{ proc: ReturnType<typeof Bun.spawn>; base: string }> {
  const proc = Bun.spawn([process.env.PYTHON ?? "python3", join(ROOT, "test", "mock_api", "server.py")], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const port = text.match(/^PORT:(\d+)/)?.[1];
  if (!port) throw new Error(`mock ArcGIS server did not report a port: ${text}`);
  return { proc, base: `http://127.0.0.1:${port}` };
}

describe("tokens against the mock ArcGIS server", () => {
  let mock: ReturnType<typeof Bun.spawn>;
  let base: string;
  let layer: string;
  const authLog = async () =>
    (await (await fetch(`${base}/_auth_log`)).json()) as { generate: number; oauth: number; rejected: number };

  beforeAll(async () => {
    ({ proc: mock, base } = await startMock());
    layer = `${base}/arcgis/rest/services/Secured/FeatureServer/0`;
  });
  afterAll(() => mock?.kill());
  beforeEach(() => {
    clearTokenCache();
    clearMetadataCache();
  });

  test("token endpoints come from /rest/info", async () => {
    expect(await tokenEndpoint(layer, "password")).toBe(`${base}/portal/sharing/rest/generateToken`);
    expect(await tokenEndpoint(layer, "client")).toBe(`${base}/portal/sharing/rest/oauth2/token`);
  });

  test("generated tokens are cached, renewed before expiry and after a rejection", async () => {
    const auth = new ArcgisAuth({ kind: "password", ...USER }, "attach");
    const before = (await authLog()).generate;
    const first = await auth.token(layer);
    expect(await auth.token(layer)).toBe(first); // cached
    expect((await authLog()).generate).toBe(before + 1);
    // A token the server rejected is replaced.
    const second = await auth.token(layer, first);
    expect(second).not.toBe(first);
    expect(await auth.token(layer, first)).toBe(second); // only the rejected one is dropped
    // Close to its expiry (an hour, less the margin), it is renewed.
    const realNow = Date.now();
    const prev = setClock(() => realNow + 60 * 60_000);
    try {
      expect(await auth.token(layer)).not.toBe(second);
    } finally {
      setClock(prev);
    }
    expect((await authLog()).generate).toBe(before + 3);
  });

  test("getJson renews a revoked token once (498) and keeps going", async () => {
    const auth = new ArcgisAuth({ kind: "password", ...USER }, "attach");
    const before = await authLog();
    // The mock revokes each issued token after 4 requests.
    for (let i = 0; i < 6; i++) {
      const body = (await getJson(`${layer}/query?where=1%3D1&outFields=*&f=json`, auth)) as { features: unknown[] };
      expect(body.features.length).toBe(2);
    }
    const after = await authLog();
    expect(after.generate - before.generate).toBe(2);
    expect(after.rejected - before.rejected).toBe(1);
  });

  test("client credentials and static tokens", async () => {
    const app = new ArcgisAuth({ kind: "client", clientId: APP.client_id, clientSecret: APP.client_secret }, "attach");
    expect(((await getJson(`${layer}?f=json`, app)) as { name: string }).name).toBe("Restricted Sites");
    const fixed = new ArcgisAuth({ kind: "token", token: "fake-static-token" }, "attach");
    expect(((await getJson(`${layer}?f=json`, fixed)) as { name: string }).name).toBe("Restricted Sites");
    const stale = new ArcgisAuth({ kind: "token", token: "fake-expired-token" }, "s1");
    const err = await getJson(`${layer}?f=json`, stale).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/498.*TOKEN of the arcgis secret 's1' is invalid or has expired/);
    expect((err as Error).message).not.toContain("fake-expired-token");
  });

  test("bad credentials: clear errors that never echo them", async () => {
    const wrong = new ArcgisAuth({ kind: "password", username: "test-user", password: "wrong-password" }, "attach");
    const err = (await wrong.token(layer).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/Invalid username or password.*Check the ATTACH options username and password/);
    expect(err.message).not.toContain("wrong-password");
    const app = new ArcgisAuth({ kind: "client", clientId: "test-client-id", clientSecret: "nope" }, "attach");
    expect(((await app.token(layer).catch((e: Error) => e)) as Error).message).toMatch(/Invalid client_id/);
  });

  test("anonymous requests get advice; metadata is cached per identity", async () => {
    await expect(getJson(`${layer}?f=json`)).rejects.toThrow(/499.*CREATE SECRET \(TYPE arcgis/);
    const fixed = new ArcgisAuth({ kind: "token", token: "fake-static-token" }, "attach");
    expect(((await getMetadata(`${layer}?f=json`, fixed)) as { name: string }).name).toBe("Restricted Sites");
    // Cached for that identity only: an anonymous caller still gets the 499.
    await expect(getMetadata(`${layer}?f=json`)).rejects.toThrow(/499/);
  });

  test("the worker never logs credentials, even at debug level", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vgi-arcgis-auth-"));
    const logFile = join(dir, "worker.log");
    const worker = join(ROOT, "src", "worker.ts");
    const client = new VgiClient(
      subprocessConnect(["sh", "-c", `exec "${process.execPath}" run "${worker}" --debug 2>>"${logFile}"`], {
        // A private key file for the secret ATTACH options, so the test leaves the user's alone.
        env: { VGI_ATTACH_SECRET_KEY_FILE: join(dir, "attach.key") },
      }),
    );
    try {
      const rowsOf = async (options: Record<string, string>) => {
        const attached = await client.catalogAttach("arcgis", {
          options: { url: `${base}/arcgis/rest/services`, ...options },
        });
        const rows: Record<string, unknown>[] = [];
        for await (const page of client.tableFunctionRows({
          functionName: "arcgis_query",
          arguments: new Arguments([layer]),
          attachOpaqueData: attached.attach_opaque_data,
          int64: "bigint",
        })) {
          rows.push(...page);
        }
        // The attach value carries the secret options encrypted, never in plaintext.
        const bytes = new TextDecoder("latin1").decode(attached.attach_opaque_data);
        for (const value of Object.values(options)) expect(bytes).not.toContain(value);
        return rows;
      };
      expect((await rowsOf(USER)).map((r) => r.SITE)).toEqual(["North Gate", "Vault", "Annex"]);
      expect((await rowsOf(USER)).length).toBe(3); // a fresh attach reuses (and renews) the cached token
      expect((await rowsOf(APP)).length).toBe(3);
      expect((await rowsOf({ token: "fake-static-token" })).length).toBe(3);
    } finally {
      client.close();
    }
    await Bun.sleep(100);
    const stderr = readFileSync(logFile, "utf8");
    rmSync(dir, { recursive: true, force: true });
    expect(stderr).toContain("DEBUG GET"); // debug logging was on
    expect(stderr).toContain("(with token)");
    for (const secret of [
      USER.password,
      APP.client_secret,
      "fake-static-token",
      "mock-user-token-",
      "mock-app-token-",
    ]) {
      expect(stderr).not.toContain(secret);
    }
  });
});
