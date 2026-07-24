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
});
