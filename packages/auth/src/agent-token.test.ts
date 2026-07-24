import { InMemoryTenantKeyStore, isAgentTokenPrefix, issueAgentToken } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { agentTokenAuthenticator } from "./agent-token.js";

describe("agentTokenAuthenticator", () => {
  it("ignores non-agt_ bearers so the composite can try the next authenticator", async () => {
    const auth = agentTokenAuthenticator({
      resolve: async () => {
        throw new Error("resolve should not be called for a non-agt_ token");
      },
    });
    expect(await auth.authenticate("ak_something")).toBeUndefined();
    expect(await auth.authenticate("eyJhbGciOi...")).toBeUndefined();
  });

  it("resolves an agt_ token to an agent principal acting as its creator, capped to write scope by default", async () => {
    const auth = agentTokenAuthenticator({ resolve: async () => ({ workspace: "acme", owner: "alice" }) });
    expect(await auth.authenticate("agt_live")).toEqual({
      subject: "alice",
      workspace: "acme",
      roles: ["member"],
      via: "agent",
      scopes: ["write"],
    });
  });

  it("carries an explicit scope when the token was issued with one", async () => {
    const auth = agentTokenAuthenticator({
      resolve: async () => ({ workspace: "acme", owner: "bob", scopes: ["read"] }),
    });
    expect((await auth.authenticate("agt_x"))?.scopes).toEqual(["read"]);
  });

  it("fails closed for an unknown / revoked token (→ 401)", async () => {
    const auth = agentTokenAuthenticator({ resolve: async () => undefined });
    expect(await auth.authenticate("agt_revoked")).toBeUndefined();
  });

  it("issues an agt_ token via the key store that resolves as its creator and is hidden from the key list (A2)", async () => {
    const store = new InMemoryTenantKeyStore();
    const token = await issueAgentToken(store, "acme", "alice");
    expect(token.startsWith("agt_")).toBe(true);
    const auth = agentTokenAuthenticator({
      resolve: async (h) => {
        const r = await store.resolveByHash(h);
        return r ? { workspace: r.tenant, owner: r.owner, scopes: r.scopes } : undefined;
      },
    });
    expect(await auth.authenticate(token)).toMatchObject({
      subject: "alice",
      workspace: "acme",
      via: "agent",
      scopes: ["write"],
    });
    // The agt_ row is filtered out of the owner's personal API-key list (not a user-managed key).
    const listed = await store.list("acme", "alice");
    expect(listed.filter((k) => !isAgentTokenPrefix(k.prefix))).toEqual([]);
  });
});
