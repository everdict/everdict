import { ForbiddenError } from "@everdict/contracts";
import { InMemoryRunnerStore, InMemoryTenantKeyStore, hashKey } from "@everdict/db";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { apiKeyAuthenticator } from "./api-key.js";
import { authorize, can } from "./authz.js";
import {
  GITHUB_ACTIONS_ISSUER,
  type GithubActionsClaims,
  githubActionsAuthenticator,
  githubEnterpriseIssuer,
} from "./github-actions.js";
import { oidcAuthenticator } from "./oidc.js";
import { type Principal, compositeAuthenticator } from "./principal.js";
import { runnerAuthenticator } from "./runner.js";

const p = (roles: string[]): Principal => ({ subject: "u", workspace: "acme", roles, via: "oidc" });

describe("authz", () => {
  it("permission matrix by role", () => {
    expect(can(p(["viewer"]), "runs:read")).toBe(true);
    expect(can(p(["viewer"]), "runs:submit")).toBe(false);
    expect(can(p(["member"]), "runs:submit")).toBe(true);
    // harness register (instance) / template (category) definition is open to anyone (viewer+) — collaborative eval content, no role gate.
    expect(can(p(["viewer"]), "harnesses:register")).toBe(true);
    expect(can(p(["member"]), "harnesses:register")).toBe(true);
    expect(can(p(["admin"]), "harnesses:register")).toBe(true);
    expect(can(p(["viewer"]), "templates:write")).toBe(true);
    expect(can(p(["member"]), "templates:write")).toBe(true);
    expect(can(p(["admin"]), "templates:write")).toBe(true);
    // datasets: read is viewer+, write is member+
    expect(can(p(["viewer"]), "datasets:read")).toBe(true);
    expect(can(p(["viewer"]), "datasets:write")).toBe(false);
    expect(can(p(["member"]), "datasets:write")).toBe(true);
    // scorecards: read is viewer+, run (batch eval) is member+
    expect(can(p(["viewer"]), "scorecards:read")).toBe(true);
    expect(can(p(["viewer"]), "scorecards:run")).toBe(false);
    expect(can(p(["member"]), "scorecards:run")).toBe(true);
    // judges: read is viewer+, register is member+ (a user registers their own judge)
    expect(can(p(["viewer"]), "judges:read")).toBe(true);
    expect(can(p(["viewer"]), "judges:write")).toBe(false);
    expect(can(p(["member"]), "judges:write")).toBe(true);
    // runtimes: read and write are both role-independent (anyone can register — the credential 'value' is separately protected by secrets:write)
    expect(can(p(["viewer"]), "runtimes:read")).toBe(true);
    expect(can(p(["viewer"]), "runtimes:write")).toBe(true);
    expect(can(p(["member"]), "runtimes:write")).toBe(true);
    expect(can(p(["admin"]), "runtimes:write")).toBe(true);

    // Connected accounts are personally owned — not in the authz matrix (self-scoped by subject, the route scopes directly).

    // reading members is viewer+, member management (role change/removal/invite) is admin-only.
    expect(can(p(["viewer"]), "members:read")).toBe(true);
    expect(can(p(["viewer"]), "members:write")).toBe(false);
    expect(can(p(["member"]), "members:write")).toBe(false);
    expect(can(p(["admin"]), "members:write")).toBe(true);
  });
  it("the ci role (GitHub Actions federation) can only fire/poll/diff + re-pin — no governance/secrets/members", () => {
    expect(can(p(["ci"]), "scorecards:run")).toBe(true);
    expect(can(p(["ci"]), "scorecards:read")).toBe(true); // poll + diff
    expect(can(p(["ci"]), "harnesses:register")).toBe(true); // durable re-pin (POST /harnesses/:id/pins)
    expect(can(p(["ci"]), "harnesses:read")).toBe(true); // read the baseline instance
    expect(can(p(["ci"]), "datasets:write")).toBe(false);
    expect(can(p(["ci"]), "runs:submit")).toBe(false);
    expect(can(p(["ci"]), "secrets:read")).toBe(false);
    expect(can(p(["ci"]), "members:read")).toBe(false);
    expect(can(p(["ci"]), "settings:write")).toBe(false);
    expect(can(p(["ci"]), "keys:write")).toBe(false);
  });

  it("authorize throws 403 when not permitted", () => {
    expect(() => authorize(p(["viewer"]), "secrets:write")).toThrow(ForbiddenError); // secret value = admin-only
    expect(() => authorize(p(["member"]), "runtimes:write")).not.toThrow(); // runtime registration = role-independent
    expect(() => authorize(p(["admin"]), "runtimes:write")).not.toThrow();
  });

  it("api-key scope narrows the key by intersecting with role permissions (read⊂write⊂admin, admin=Full Access)", () => {
    const key = (scopes: string[]): Principal => ({
      subject: "key:acme",
      workspace: "acme",
      roles: ["admin"], // the key is issued with the admin role but scope narrows it further
      via: "api-key",
      scopes,
    });
    // read scope: data reads only, no writes or sensitive reads
    expect(can(key(["read"]), "datasets:read")).toBe(true);
    expect(can(key(["read"]), "datasets:write")).toBe(false);
    expect(can(key(["read"]), "secrets:read")).toBe(false); // a sensitive read needs admin scope
    expect(can(key(["read"]), "keys:read")).toBe(false);
    // write scope: read ∪ content mutation, no governance (secrets/members/keys)
    expect(can(key(["write"]), "datasets:read")).toBe(true);
    expect(can(key(["write"]), "datasets:write")).toBe(true);
    expect(can(key(["write"]), "runs:submit")).toBe(true);
    expect(can(key(["write"]), "secrets:write")).toBe(false);
    expect(can(key(["write"]), "members:write")).toBe(false);
    expect(can(key(["write"]), "keys:write")).toBe(false);
    // admin scope (= Full Access): everything
    expect(can(key(["admin"]), "datasets:write")).toBe(true);
    expect(can(key(["admin"]), "secrets:write")).toBe(true);
    expect(can(key(["admin"]), "keys:write")).toBe(true);
    // intersection: even with admin scope, a viewer role can't exceed viewer permissions
    const viewerKey: Principal = {
      subject: "key:acme",
      workspace: "acme",
      roles: ["viewer"],
      via: "api-key",
      scopes: ["admin"],
    };
    expect(can(viewerKey, "datasets:read")).toBe(true);
    expect(can(viewerKey, "datasets:write")).toBe(false);
    // a key with no scope (legacy/full) is unlimited (role as-is)
    const legacy: Principal = { subject: "key:acme", workspace: "acme", roles: ["admin"], via: "api-key" };
    expect(can(legacy, "secrets:write")).toBe(true);
  });
});

describe("apiKeyAuthenticator", () => {
  it("key hash → workspace (default admin role)", async () => {
    const store = new InMemoryTenantKeyStore();
    await store.add("acme", hashKey("ak_secret"));
    const auth = apiKeyAuthenticator({ keyStore: store });
    expect(await auth.authenticate("ak_secret")).toMatchObject({ workspace: "acme", roles: ["admin"], via: "api-key" });
    expect(await auth.authenticate("ak_wrong")).toBeUndefined();
    expect(await auth.authenticate("eyJ.a.b")).toBeUndefined(); // JWT is ignored
  });

  it("a scoped key flows through to Principal.scopes (unlimited when absent)", async () => {
    const store = new InMemoryTenantKeyStore();
    await store.add("acme", hashKey("ak_scoped"), { scopes: ["read"] });
    await store.add("acme", hashKey("ak_full"));
    const auth = apiKeyAuthenticator({ keyStore: store });
    expect((await auth.authenticate("ak_scoped"))?.scopes).toEqual(["read"]);
    expect((await auth.authenticate("ak_full"))?.scopes).toBeUndefined();
  });
});

describe("runnerAuthenticator (self-hosted runner pairing token)", () => {
  it("rnr_ token → {owner, workspace, runnerId} + roles=['runner'], via='runner'", async () => {
    const store = new InMemoryRunnerStore();
    const paired = await store.pair({ owner: "u-alice", workspace: "acme", label: "laptop" });
    const auth = runnerAuthenticator({ runnerStore: store });
    expect(await auth.authenticate(paired.token)).toMatchObject({
      subject: "u-alice",
      workspace: "acme",
      roles: ["runner"],
      via: "runner",
      runnerId: paired.meta.id,
    });
    expect(await auth.authenticate("rnr_wrong")).toBeUndefined();
    expect(await auth.authenticate("ak_x")).toBeUndefined(); // non-rnr is ignored (falls through to the next authenticator)
  });
});

describe("oidcAuthenticator (Keycloak JWT)", () => {
  const ISSUER = "https://kc.example/realms/everdict";
  let keySet: ReturnType<typeof createLocalJWKSet>;
  let priv: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    priv = privateKey;
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test";
    jwk.alg = "RS256";
    keySet = createLocalJWKSet({ keys: [jwk] });
  });

  const mint = (claims: Record<string, unknown>, issuer = ISSUER) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(issuer)
      .setSubject("user-1")
      .setExpirationTime("5m")
      .sign(priv);

  it("Keycloak is authentication-only — realm_access.roles is ignored (roles=[]; authorization SSOT is membership)", async () => {
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet });
    const token = await mint({ workspace: "acme", realm_access: { roles: ["admin", "uma_authorization"] } });
    expect(await auth.authenticate(token)).toMatchObject({
      subject: "user-1",
      workspace: "acme",
      roles: [], // token roles are not used for authorization — even realm 'admin' is ignored
      via: "oidc",
    });
  });

  it("workspace falls back from a group (/workspaces/<ws>) (roles are independent of the token)", async () => {
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet });
    const token = await mint({ groups: ["/workspaces/globex/eng"], realm_access: { roles: ["admin"] } });
    const principal = await auth.authenticate(token);
    expect(principal?.workspace).toBe("globex");
    expect(principal?.roles).toEqual([]); // Keycloak roles ignored — membership is the SSOT
  });

  it("captures the email claim (for the member list display); falls back to preferred_username, unset when neither exists", async () => {
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet });
    expect((await auth.authenticate(await mint({ workspace: "acme", email: "alice@corp.com" })))?.email).toBe(
      "alice@corp.com",
    );
    expect((await auth.authenticate(await mint({ workspace: "acme", preferred_username: "alice" })))?.email).toBe(
      "alice",
    );
    expect((await auth.authenticate(await mint({ workspace: "acme" })))?.email).toBeUndefined();
  });

  it("rejects an issuer-mismatched/forged token (undefined)", async () => {
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet });
    const wrong = await mint({ workspace: "acme" }, "https://evil/realms/x");
    expect(await auth.authenticate(wrong)).toBeUndefined();
    expect(await auth.authenticate("ak_key")).toBeUndefined(); // key is ignored
  });

  it("on verification failure, reports the reason via onError (code/expected issuer/token iss/claim keys) — to diagnose a 401", async () => {
    const calls: Array<{ code: string; expectedIssuer: string; tokenIssuer?: string; claimKeys?: string[] }> = [];
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet, onError: (info) => calls.push(info) });
    // issuer-mismatched token: rejected, and onError carries the expected issuer, the token's actual iss (decoded before verification), and the claim keys.
    const wrong = await mint({ workspace: "acme", realm_access: { roles: ["member"] } }, "https://evil/realms/x");
    expect(await auth.authenticate(wrong)).toBeUndefined();
    expect(calls).toHaveLength(1);
    const info = calls[0];
    expect(info).toBeDefined();
    if (!info) return; // type guard (no non-null !)
    expect(info.expectedIssuer).toBe(ISSUER);
    expect(info.tokenIssuer).toBe("https://evil/realms/x");
    expect(info.claimKeys).toEqual(expect.arrayContaining(["workspace", "iss", "sub"]));
    expect(typeof info.code).toBe("string");
  });

  it("a non-JWT (API key, etc.) is not verified, so onError is not called", async () => {
    const calls: unknown[] = [];
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet, onError: () => calls.push(1) });
    expect(await auth.authenticate("ak_some_key")).toBeUndefined();
    expect(calls).toHaveLength(0); // "not my credential" is normal — no noise logs
  });

  it("a valid token authenticates even without a workspace claim/group (workspace=''; membership is the SSOT)", async () => {
    const auth = oidcAuthenticator({ issuer: ISSUER, keySet });
    const token = await mint({ realm_access: { roles: ["member"] } }); // no workspace claim
    expect(await auth.authenticate(token)).toMatchObject({
      subject: "user-1",
      workspace: "", // no workspace yet → subject to onboarding (workspace creation) (not a 401)
      roles: [], // Keycloak roles ignored — after creation, membership (creator=admin) grants the role
      via: "oidc",
    });
  });
});

describe("compositeAuthenticator", () => {
  it("handles both JWT and API key", async () => {
    const store = new InMemoryTenantKeyStore();
    await store.add("acme", hashKey("ak_k"));
    const composite = compositeAuthenticator([apiKeyAuthenticator({ keyStore: store })]);
    expect((await composite.authenticate("ak_k"))?.workspace).toBe("acme");
    expect(await composite.authenticate("nope")).toBeUndefined();
  });
});

describe("githubActionsAuthenticator (GitHub Actions OIDC federation)", () => {
  let keySet: ReturnType<typeof createLocalJWKSet>;
  let priv: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    priv = privateKey;
    const jwk = await exportJWK(publicKey);
    jwk.kid = "gha";
    jwk.alg = "RS256";
    keySet = createLocalJWKSet({ keys: [jwk] });
  });

  const mint = (claims: Record<string, unknown>, issuer = GITHUB_ACTIONS_ISSUER, audience = "everdict") =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "gha" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("repo:acme/app:ref:refs/heads/main")
      .setExpirationTime("5m")
      .sign(priv);

  // Trust: workspace acme's repo link trusts only acme/app (case-insensitive).
  const trustAcmeApp = async (claims: { repository: string }, hint: string) =>
    hint === "acme" && claims.repository.toLowerCase() === "acme/app"
      ? { workspace: "acme", roles: ["ci"] }
      : undefined;

  it("a valid token from a trusted repo + workspaceHint → Principal(via=github-actions, roles=[ci])", async () => {
    const auth = githubActionsAuthenticator({ keySet, resolveTrust: trustAcmeApp });
    const token = await mint({ repository: "acme/app", ref: "refs/pull/7/merge", event_name: "pull_request" });
    expect(await auth.authenticate(token, { workspaceHint: "acme" })).toEqual({
      subject: "gha:acme/app",
      workspace: "acme",
      roles: ["ci"],
      via: "github-actions",
    });
  });

  it("no workspaceHint → unauthenticated (fail-closed) — nothing to match against any workspace's link", async () => {
    const auth = githubActionsAuthenticator({ keySet, resolveTrust: trustAcmeApp });
    const token = await mint({ repository: "acme/app" });
    expect(await auth.authenticate(token)).toBeUndefined();
  });

  it("a repo not in a link → unauthenticated (401 — no existence leak)", async () => {
    const auth = githubActionsAuthenticator({ keySet, resolveTrust: trustAcmeApp });
    const token = await mint({ repository: "evil/other" });
    expect(await auth.authenticate(token, { workspaceHint: "acme" })).toBeUndefined();
  });

  it("audience mismatch (aud≠everdict) → unauthenticated", async () => {
    const auth = githubActionsAuthenticator({ keySet, resolveTrust: trustAcmeApp });
    const token = await mint({ repository: "acme/app" }, GITHUB_ACTIONS_ISSUER, "sts.amazonaws.com");
    expect(await auth.authenticate(token, { workspaceHint: "acme" })).toBeUndefined();
  });

  it("a JWT from another issuer (Keycloak, etc.) passes without a verification attempt — resolveTrust not called (avoids composite noise)", async () => {
    const calls: unknown[] = [];
    const auth = githubActionsAuthenticator({
      keySet,
      resolveTrust: async (c, h) => {
        calls.push([c, h]);
        return undefined;
      },
    });
    const keycloak = await mint({ repository: "acme/app" }, "https://kc.example/realms/everdict");
    expect(await auth.authenticate(keycloak, { workspaceHint: "acme" })).toBeUndefined();
    expect(await auth.authenticate("ak_key", { workspaceHint: "acme" })).toBeUndefined(); // non-JWT passes too
    expect(calls).toHaveLength(0);
  });

  describe("GHES federation (enterprise) — dynamically verify only the issuer of a GHE host the workspace trusts", () => {
    const GHE_HOST = "https://ghe.acme.io";
    const GHE_ISSUER = githubEnterpriseIssuer(GHE_HOST); // https://ghe.acme.io/_services/token

    it("a GHES token from a trusted host → claims.host is carried and passed to resolveTrust, and a Principal is issued", async () => {
      const seen: GithubActionsClaims[] = [];
      const auth = githubActionsAuthenticator({
        keySet,
        enterprise: { hostsFor: async (hint) => (hint === "acme" ? [GHE_HOST] : []), keySetFor: () => keySet },
        resolveTrust: async (claims) => {
          seen.push(claims);
          return claims.host === GHE_HOST && claims.repository === "acme/app"
            ? { workspace: "acme", roles: ["ci"] }
            : undefined;
        },
      });
      const token = await mint({ repository: "acme/app" }, GHE_ISSUER);
      expect(await auth.authenticate(token, { workspaceHint: "acme" })).toEqual({
        subject: "gha:acme/app",
        workspace: "acme",
        roles: ["ci"],
        via: "github-actions",
      });
      expect(seen[0]?.host).toBe(GHE_HOST);
    });

    it("a GHE issuer not in hostsFor is unauthenticated without a verification attempt (fail-closed) — resolveTrust not called", async () => {
      const calls: unknown[] = [];
      const auth = githubActionsAuthenticator({
        keySet,
        enterprise: { hostsFor: async () => ["https://other-ghe.example"], keySetFor: () => keySet },
        resolveTrust: async (c) => {
          calls.push(c);
          return { workspace: "acme", roles: ["ci"] };
        },
      });
      const token = await mint({ repository: "acme/app" }, GHE_ISSUER);
      expect(await auth.authenticate(token, { workspaceHint: "acme" })).toBeUndefined();
      expect(calls).toHaveLength(0);
    });

    it("with enterprise unset, a GHES token silently passes as before", async () => {
      const auth = githubActionsAuthenticator({ keySet, resolveTrust: trustAcmeApp });
      const token = await mint({ repository: "acme/app" }, GHE_ISSUER);
      expect(await auth.authenticate(token, { workspaceHint: "acme" })).toBeUndefined();
    });

    it("claims.host is undefined for a github.com issuer token — distinguished from a GHE link", async () => {
      const seen: GithubActionsClaims[] = [];
      const auth = githubActionsAuthenticator({
        keySet,
        enterprise: { hostsFor: async () => [GHE_HOST], keySetFor: () => keySet },
        resolveTrust: async (claims) => {
          seen.push(claims);
          return { workspace: "acme", roles: ["ci"] };
        },
      });
      const token = await mint({ repository: "acme/app" });
      await auth.authenticate(token, { workspaceHint: "acme" });
      expect(seen[0]?.host).toBeUndefined();
    });
  });
});
