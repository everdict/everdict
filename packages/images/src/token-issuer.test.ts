import { generateKeyPairSync } from "node:crypto";
import { BadRequestError, UnauthenticatedError } from "@everdict/contracts";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";
import { GRANT_AUDIENCE, type RegistryAccess, RegistryTokenIssuer, narrowAccess, parseScopes } from "./token-issuer.js";

// Keys are generated per run — a test fixture private key in the repo would be a real secret in git history
// (and the gitleaks gate would be right to stop it).
function keys() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}
const CERT = "-----BEGIN CERTIFICATE-----\nZmFrZS1jZXJ0aWZpY2F0ZS1ib2R5\n-----END CERTIFICATE-----";

function issuerAt(now: number, privateKeyPem = keys()) {
  return new RegistryTokenIssuer({
    privateKeyPem,
    certificatePem: CERT,
    issuer: "https://cp.everdict.test",
    service: "everdict-registry",
    now: () => now,
  });
}

const ACCESS: RegistryAccess[] = [{ type: "repository", name: "acme-1a2b3c4d/officeqa", actions: ["pull"] }];

describe("RegistryTokenIssuer — configuration", () => {
  it("names the mistake when the certificate slot holds the private key", () => {
    const pem = keys();
    expect(() => issuerAt(0, pem)).not.toThrow();
    expect(
      () =>
        new RegistryTokenIssuer({
          privateKeyPem: pem,
          certificatePem: pem, // the operator pasted the key twice
          issuer: "i",
          service: "s",
        }),
    ).toThrow(/PRIVATE KEY/);
  });

  it("rejects an unreadable signing key rather than starting and failing every push later", () => {
    expect(
      () => new RegistryTokenIssuer({ privateKeyPem: "not a key", certificatePem: CERT, issuer: "i", service: "s" }),
    ).toThrow(BadRequestError);
  });
});

describe("RegistryTokenIssuer — grants", () => {
  it("mints a grant carrying its access, and verifies the grant it issued", async () => {
    const issuer = issuerAt(1_700_000_000_000);
    const { token, expiresAt } = await issuer.mintGrant("acme", ACCESS);
    expect(decodeJwt(token).aud).toBe(GRANT_AUDIENCE);
    expect(new Date(expiresAt).getTime()).toBe(1_700_000_000_000 + 900_000);
    await expect(issuer.verifyGrant(token)).resolves.toEqual({ subject: "acme", access: ACCESS });
  });

  it("refuses a grant with no access — an empty authorization is a bug, not a no-op credential", async () => {
    await expect(issuerAt(0).mintGrant("acme", [])).rejects.toThrow(BadRequestError);
  });

  it("refuses a grant signed by a DIFFERENT key (a token we did not issue authorizes nothing)", async () => {
    const mine = issuerAt(0);
    const theirs = issuerAt(0);
    const { token } = await theirs.mintGrant("attacker", ACCESS);
    await expect(mine.verifyGrant(token)).rejects.toThrow(UnauthenticatedError);
  });

  it("refuses an expired grant — short lifetimes are what make revoked reach stop working", async () => {
    const key = keys();
    const { token } = await issuerAt(1_700_000_000_000, key).mintGrant("acme", ACCESS);
    const later = issuerAt(1_700_000_000_000 + 901_000, key);
    await expect(later.verifyGrant(token)).rejects.toThrow(UnauthenticatedError);
  });

  it("refuses a registry token presented as a grant (the two audiences are not interchangeable)", async () => {
    const key = keys();
    const issuer = issuerAt(0, key);
    const registryToken = await issuer.mintRegistryToken("acme", ACCESS);
    await expect(issuer.verifyGrant(registryToken)).rejects.toThrow(UnauthenticatedError);
  });
});

describe("RegistryTokenIssuer — the registry-facing token", () => {
  it("carries the certificate in x5c and the registry service as its audience", async () => {
    const token = await issuerAt(1_700_000_000_000).mintRegistryToken("acme", ACCESS);
    expect(decodeProtectedHeader(token).x5c).toEqual(["ZmFrZS1jZXJ0aWZpY2F0ZS1ib2R5"]);
    const claims = decodeJwt(token);
    expect(claims.aud).toBe("everdict-registry");
    expect(claims.iss).toBe("https://cp.everdict.test");
    expect(claims.access).toEqual(ACCESS);
  });
});

describe("narrowAccess — a grant can only be narrowed, never widened", () => {
  const granted: RegistryAccess[] = [
    { type: "repository", name: "acme/a", actions: ["pull", "push"] },
    { type: "repository", name: "acme/b", actions: ["pull"] },
  ];

  it("intersects the requested scope with the grant", () => {
    expect(narrowAccess(granted, [{ type: "repository", name: "acme/a", actions: ["pull"] }])).toEqual([
      { type: "repository", name: "acme/a", actions: ["pull"] },
    ]);
  });

  it("drops an action the grant does not carry (a pull grant never yields push)", () => {
    expect(narrowAccess(granted, [{ type: "repository", name: "acme/b", actions: ["push"] }])).toEqual([]);
  });

  it("drops a repository the grant never mentioned — including another workspace's", () => {
    expect(narrowAccess(granted, [{ type: "repository", name: "other-ws/secret", actions: ["pull"] }])).toEqual([]);
  });
});

describe("parseScopes — the registry's scope parameter", () => {
  it("parses repository scopes with one or several actions", () => {
    expect(parseScopes(["repository:acme-1a2b/officeqa:pull,push"])).toEqual([
      { type: "repository", name: "acme-1a2b/officeqa", actions: ["pull", "push"] },
    ]);
  });

  it("keeps a repository name containing colons intact (the last segment is the action list)", () => {
    expect(parseScopes(["repository:host:5000/x:pull"])).toEqual([
      { type: "repository", name: "host:5000/x", actions: ["pull"] },
    ]);
  });

  it("ignores scopes it does not grant instead of failing the whole exchange", () => {
    expect(parseScopes(["registry:catalog:*", "repository:acme/a:pull"])).toEqual([
      { type: "repository", name: "acme/a", actions: ["pull"] },
    ]);
    expect(parseScopes(["nonsense", "repository:acme/a:delete"])).toEqual([]);
  });
});
