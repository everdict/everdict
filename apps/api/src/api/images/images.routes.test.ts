import { generateKeyPairSync } from "node:crypto";
import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore } from "@everdict/db";
import { ImageTokenService, RegistryTokenIssuer } from "@everdict/images";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused");
  },
};

const CERT = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----";
const NS = "acme-1a2b3c4d";

function build() {
  const issuer = new RegistryTokenIssuer({
    privateKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
    certificatePem: CERT,
    issuer: "everdict",
    service: "everdict-registry",
  });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    imageTokenService: new ImageTokenService({ issuer, service: "everdict-registry" }),
  });
  return { app, issuer };
}

// The docker client's half of the handshake: basic auth whose PASSWORD is the grant.
function basic(grant: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`everdict:${grant}`).toString("base64")}` };
}

// A JWT segment, decoded without pulling `jose` into apps/api — the signing library belongs to @everdict/images,
// and a test assertion is no reason to widen this app's dependency set.
function segment(jwt: string, index: 0 | 1): Record<string, unknown> {
  const part = jwt.split(".")[index];
  if (!part) throw new Error("not a JWT");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}
const decodeProtectedHeader = (jwt: string) => segment(jwt, 0);
const decodeJwt = (jwt: string) => segment(jwt, 1);

describe("GET /v2/token — the managed registry's auth realm", () => {
  it("exchanges a grant for a token scoped to the requested repository", async () => {
    const { app, issuer } = build();
    const { token: grant } = await issuer.mintGrant("acme", [
      { type: "repository", name: `${NS}/officeqa`, actions: ["pull", "push"] },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/v2/token?service=everdict-registry&scope=repository:${NS}/officeqa:pull`,
      headers: basic(grant),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBe(body.access_token); // both spellings, one value — clients read either
    expect(decodeProtectedHeader(body.token).x5c).toEqual(["ZmFrZQ=="]);
    const claims = decodeJwt(body.token);
    expect(claims.aud).toBe("everdict-registry");
    expect(claims.access).toEqual([{ type: "repository", name: `${NS}/officeqa`, actions: ["pull"] }]);
  });

  it("issues a token with NO access for a scope the grant does not cover", async () => {
    const { app, issuer } = build();
    const { token: grant } = await issuer.mintGrant("acme", [
      { type: "repository", name: `${NS}/officeqa`, actions: ["pull"] },
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/v2/token?service=everdict-registry&scope=repository:rival-9f8e7d6c/secret:pull",
      headers: basic(grant),
    });
    // Not a 403: the registry is the authority on its own resources, and it answers 401 for a token that
    // carries no access. Refusing here would also break a multi-scope request whose other scopes are legitimate.
    expect(res.statusCode).toBe(200);
    expect(decodeJwt(res.json().token).access).toEqual([]);
  });

  it("never upgrades a pull grant to push", async () => {
    const { app, issuer } = build();
    const { token: grant } = await issuer.mintGrant("acme", [
      { type: "repository", name: `${NS}/officeqa`, actions: ["pull"] },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/v2/token?service=everdict-registry&scope=repository:${NS}/officeqa:pull,push`,
      headers: basic(grant),
    });
    expect(decodeJwt(res.json().token).access).toEqual([
      { type: "repository", name: `${NS}/officeqa`, actions: ["pull"] },
    ]);
  });

  it("succeeds with empty access when no scope is asked for — that is `docker login`", async () => {
    const { app, issuer } = build();
    const { token: grant } = await issuer.mintGrant("acme", [
      { type: "repository", name: `${NS}/officeqa`, actions: ["pull"] },
    ]);
    const res = await app.inject({ method: "GET", url: "/v2/token", headers: basic(grant) });
    expect(res.statusCode).toBe(200);
    expect(decodeJwt(res.json().token).access).toEqual([]);
  });

  it("401s an anonymous request — a private registry never answers with a usable token", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: "/v2/token?scope=repository:x/y:pull" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Basic realm=");
  });

  it("401s a grant signed by someone else", async () => {
    const { app } = build();
    const { issuer: foreign } = build();
    const { token: grant } = await foreign.mintGrant("attacker", [
      { type: "repository", name: `${NS}/officeqa`, actions: ["push"] },
    ]);
    const res = await app.inject({ method: "GET", url: "/v2/token", headers: basic(grant) });
    expect(res.statusCode).toBe(401);
  });

  it("401s a request for a different registry service (the token would be rejected anyway)", async () => {
    const { app, issuer } = build();
    const { token: grant } = await issuer.mintGrant("acme", [
      { type: "repository", name: `${NS}/officeqa`, actions: ["pull"] },
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/v2/token?service=someone-elses-registry",
      headers: basic(grant),
    });
    expect(res.statusCode).toBe(401);
  });

  it("404s when the deployment runs no managed store (BYO-only), rather than pretending one exists", async () => {
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    });
    const res = await app.inject({ method: "GET", url: "/v2/token" });
    expect(res.statusCode).toBe(404);
  });
});
