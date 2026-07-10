import { generateKeyPairSync, verify } from "node:crypto";
import { UpstreamError } from "@everdict/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getInstallation, githubAppJwt, mintInstallationToken } from "./github-app.js";

// RSA keypair for tests (stands in for the App private key). Exported as PEM for signing/verification.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// fetch stub — captures (url, init) so requests can be asserted too.
function mockFetch(
  handler: (url: string) => { status?: number; body: unknown },
): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const { status = 200, body } = handler(String(url));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
}

describe("githubAppJwt", () => {
  it("carries an RS256 header + iss/iat/exp claims and is signed with the private key", () => {
    const jwt = githubAppJwt({ appId: "12345", privateKeyPem: privateKey, nowSec: 1_000_000 });
    const [h, p, sig] = jwt.split(".");
    if (h === undefined || p === undefined || sig === undefined) throw new Error("malformed JWT (not 3 parts)");
    expect(decodeSegment(h)).toEqual({ alg: "RS256", typ: "JWT" });
    // iat is skewed back 60s to absorb clock drift, exp is within 10 minutes.
    expect(decodeSegment(p)).toEqual({ iss: "12345", iat: 999_940, exp: 1_000_540 });
    // Verify the signature with the public key (not forged).
    const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("mintInstallationToken (github.com)", () => {
  const base = { appId: "12345", privateKeyPem: privateKey, installationId: 42, nowSec: 1_000_000 };

  it("requests an installation access token narrowed to selected repos + permissions and parses it", async () => {
    const calls = mockFetch(() => ({ body: { token: "ghs_abc", expires_at: "2026-07-05T12:00:00Z" } }));
    const tok = await mintInstallationToken({
      ...base,
      repositories: ["api"],
      permissions: { contents: "read" },
    });
    expect(tok).toEqual({ token: "ghs_abc", expiresAt: "2026-07-05T12:00:00Z" });

    const call = calls[0];
    expect(call?.url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(call?.init?.method).toBe("POST");
    // Authenticate by carrying the App JWT as a Bearer.
    const auth = (call?.init?.headers as Record<string, string>).authorization;
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    // The body carries the selected repos + permissions as-is (GitHub limits the token to this scope).
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      repositories: ["api"],
      permissions: { contents: "read" },
    });
  });

  it("an external failure (non-2xx) is remapped to UpstreamError", async () => {
    mockFetch(() => ({ status: 404, body: { message: "Not Found" } }));
    await expect(mintInstallationToken({ ...base, repositories: ["api"] })).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("getInstallation", () => {
  it("looks up the installation with the App JWT and extracts the account (org login)", async () => {
    const calls = mockFetch(() => ({ body: { id: 42, account: { login: "acme-org" } } }));
    const info = await getInstallation({
      appId: "12345",
      privateKeyPem: privateKey,
      installationId: 42,
      nowSec: 1_000_000,
    });
    expect(info).toEqual({ account: "acme-org" });
    expect(calls[0]?.url).toBe("https://api.github.com/app/installations/42");
  });
});

describe("mintInstallationToken (GHE — host branch)", () => {
  it("with a host, the api base switches to GHE (/api/v3)", async () => {
    const calls = mockFetch(() => ({ body: { token: "ghs_ent", expires_at: "2026-07-05T12:00:00Z" } }));
    await mintInstallationToken({
      host: "https://ghe.acme.io",
      appId: "9",
      privateKeyPem: privateKey,
      installationId: 7,
      repositories: ["svc"],
      nowSec: 1_000_000,
    });
    expect(calls[0]?.url).toBe("https://ghe.acme.io/api/v3/app/installations/7/access_tokens");
  });
});
