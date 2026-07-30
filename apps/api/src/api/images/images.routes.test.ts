import { generateKeyPairSync } from "node:crypto";
import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore } from "@everdict/db";
import { ImageTokenService, InMemoryImageStore, RegistryTokenIssuer } from "@everdict/images";
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
  const images = new InMemoryImageStore({ endpoint: "images.everdict.test" });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    imageTokenService: new ImageTokenService({ issuer, service: "everdict-registry" }),
    images,
  });
  return { app, issuer, images };
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

const acme = { "x-everdict-tenant": "acme" };

describe("POST /workspace/images/push-grant — the publish half", () => {
  it("mints a grant for the repository plus the prefix the client builds the ref with", async () => {
    const { app, images } = build();
    const res = await app.inject({
      method: "POST",
      url: "/workspace/images/push-grant",
      headers: acme,
      payload: { repository: "officeqa" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const namespace = images.namespaceFor("acme");
    expect(body.imagePrefix).toBe(`images.everdict.test/${namespace}/`);
    expect(body.grant.repositories).toEqual([`${namespace}/officeqa`]);
    expect(body.grant.actions).toEqual(["pull", "push"]);
  });

  it("refuses a repository outside the caller's namespace", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/workspace/images/push-grant",
      headers: acme,
      payload: { repository: "rival-9f8e7d6c/secret" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s without a repository, and 404s when no managed store is configured", async () => {
    const { app } = build();
    expect(
      (await app.inject({ method: "POST", url: "/workspace/images/push-grant", headers: acme, payload: {} }))
        .statusCode,
    ).toBe(400);
    const byoOnly = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    });
    const res = await byoOnly.inject({
      method: "POST",
      url: "/workspace/images/push-grant",
      headers: acme,
      payload: { repository: "officeqa" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /workspace/images/manifest — the digest a pushed image is pinned by", () => {
  it("answers with the digest the registry stored", async () => {
    const { app, images } = build();
    const digest = images.push("acme", "officeqa", "v1");
    const res = await app.inject({
      method: "GET",
      url: `/workspace/images/manifest?repository=${images.namespaceFor("acme")}/officeqa&reference=v1`,
      headers: acme,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().digest).toBe(digest);
  });

  it("404s for a reference the workspace does not hold", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "GET",
      url: "/workspace/images/manifest?repository=officeqa&reference=v1",
      headers: acme,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /workspace/images — the catalog Settings › Images renders", () => {
  it("lists the workspace's repositories with the coordinates their refs are built from", async () => {
    // Given: two repositories published into acme's namespace
    const { app, images } = build();
    images.push("acme", "officeqa", "v1", { sizeBytes: 120 });
    images.push("acme", "browser-env", "v2", { sizeBytes: 80 });
    // When
    const res = await app.inject({ method: "GET", url: "/workspace/images", headers: acme });
    // Then
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.endpoint).toBe("images.everdict.test");
    expect(body.namespace).toBe(images.namespaceFor("acme"));
    expect(body.repositories.map((r: { name: string }) => r.name).sort()).toEqual(["browser-env", "officeqa"]);
    expect(body.usage.repositories).toBe(2);
  });

  it("scopes to the caller's own namespace — another workspace's images are not listed", async () => {
    const { app, images } = build();
    images.push("rival", "secret", "v1");
    const res = await app.inject({ method: "GET", url: "/workspace/images", headers: acme });
    expect(res.statusCode).toBe(200);
    expect(res.json().repositories).toEqual([]);
  });

  it("is 404 when the deployment runs no managed store", async () => {
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    });
    const res = await app.inject({ method: "GET", url: "/workspace/images", headers: acme });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /workspace/images/:repository/tags — the drill-in", () => {
  it("resolves the tags of one repository", async () => {
    const { app, images } = build();
    images.push("acme", "officeqa", "v1");
    images.push("acme", "officeqa", "v2");
    const res = await app.inject({ method: "GET", url: "/workspace/images/officeqa/tags", headers: acme });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ repository: "officeqa", tags: ["v1", "v2"] });
  });

  it("reads an unknown repository as an empty tag list, like the registry itself", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: "/workspace/images/nothing/tags", headers: acme });
    expect(res.statusCode).toBe(200);
    expect(res.json().tags).toEqual([]);
  });
});

describe("DELETE /workspace/images/:repository — unpublish", () => {
  it("unlinks the repository's manifests and reports the count", async () => {
    const { app, images } = build();
    images.push("acme", "officeqa", "v1");
    images.push("acme", "officeqa", "v2");
    const res = await app.inject({ method: "DELETE", url: "/workspace/images/officeqa", headers: acme });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ repository: "officeqa", removed: 2 });
    const after = await app.inject({ method: "GET", url: "/workspace/images", headers: acme });
    expect(after.json().repositories).toEqual([]);
  });

  it("refuses a viewer — retracting an image takes the same images:push right as publishing it", async () => {
    // Given: a viewer principal (the dev fallback is admin, so authZ needs a real authenticator)
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      images: new InMemoryImageStore({ endpoint: "images.everdict.test" }),
      requireAuth: true,
      authenticator: {
        async authenticate() {
          return { subject: "u", workspace: "acme", roles: ["viewer"], via: "oidc" as const };
        },
      },
    });
    // When
    const res = await app.inject({
      method: "DELETE",
      url: "/workspace/images/officeqa",
      headers: { authorization: "Bearer t" },
    });
    // Then
    expect(res.statusCode).toBe(403);
  });
});
