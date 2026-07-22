import { type OfflineTokenMinter, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { UpstreamError } from "@everdict/contracts";
import { InMemoryRunStore, InMemorySecretStore, generatedCipher } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in offline-token route tests");
  },
};

// A fake minter: a valid grant mints a fixed token; refreshToken='bad' models a provider-rejected grant.
const minter: OfflineTokenMinter = {
  async mint(grant) {
    if (grant.refreshToken === "bad") throw new UpstreamError("UPSTREAM_ERROR", {}, "invalid_grant");
    return { accessToken: "at-1", expiresAt: "2026-01-01T01:00:00.000Z", refreshToken: "rt-2" };
  },
};

function build() {
  const secretStore = new InMemorySecretStore(generatedCipher(), undefined, minter);
  const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
  return buildServer({ service, secretStore });
}

const H = { "x-everdict-tenant": "acme" };
const GRANT = { tokenUrl: "https://id.example.com/oauth/token", clientId: "client-1", refreshToken: "rt-1" };

describe("PUT /secrets/:name/offline-token", () => {
  it("registers an offline token and returns its metadata with the computed access-token expiry", async () => {
    const app = build();
    const res = await app.inject({
      method: "PUT",
      url: "/secrets/MY_TOKEN/offline-token",
      headers: H,
      payload: { grant: GRANT, scope: "workspace" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: "MY_TOKEN",
      scope: "workspace",
      kind: "offline_token",
      updatedAt: expect.any(String),
      accessTokenExpiresAt: "2026-01-01T01:00:00.000Z",
    });

    // it shows up in the list tagged as an offline token (values are never returned)
    const list = await app.inject({ method: "GET", url: "/secrets", headers: H });
    expect(list.json()).toContainEqual(
      expect.objectContaining({
        name: "MY_TOKEN",
        kind: "offline_token",
        accessTokenExpiresAt: "2026-01-01T01:00:00.000Z",
      }),
    );
  });

  it("returns 502 when the provider rejects the refresh token", async () => {
    const res = await build().inject({
      method: "PUT",
      url: "/secrets/MY_TOKEN/offline-token",
      headers: H,
      payload: { grant: { ...GRANT, refreshToken: "bad" }, scope: "workspace" },
    });
    expect(res.statusCode).toBe(502);
  });

  it("rejects a non-env secret name (400)", async () => {
    const res = await build().inject({
      method: "PUT",
      url: "/secrets/not-env/offline-token",
      headers: H,
      payload: { grant: GRANT, scope: "workspace" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed grant — missing token endpoint (400)", async () => {
    const res = await build().inject({
      method: "PUT",
      url: "/secrets/MY_TOKEN/offline-token",
      headers: H,
      payload: { grant: { clientId: "c", refreshToken: "r" }, scope: "workspace" },
    });
    expect(res.statusCode).toBe(400);
  });
});
