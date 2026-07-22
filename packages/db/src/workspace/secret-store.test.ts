import type { OfflineTokenMinter } from "@everdict/application-control";
import { UpstreamError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { aesGcmCipher, generatedCipher } from "./secret-cipher.js";
import { InMemorySecretStore } from "./secret-store.js";

const cipher = aesGcmCipher(Buffer.alloc(32, 7)); // fixed 32-byte key for tests

// A controllable offline-token harness: a fake minter (numbered access/refresh tokens, 1h TTL, rotating), a movable
// clock, and a store wired to both. The minter can be flipped to fail to exercise the best-effort refresh path.
const BASE = Date.parse("2026-01-01T00:00:00Z");
function offlineSetup() {
  let nowMs = BASE;
  let n = 0;
  let failing = false;
  const grants: Array<{ refreshToken: string }> = [];
  const minter: OfflineTokenMinter = {
    async mint(grant) {
      grants.push({ refreshToken: grant.refreshToken });
      if (failing) throw new UpstreamError("UPSTREAM_ERROR", {}, "provider down");
      n += 1;
      return {
        accessToken: `access-${n}`,
        expiresAt: new Date(nowMs + 3_600_000).toISOString(), // +1h from the mint moment
        refreshToken: `refresh-${n}`,
      };
    },
  };
  const store = new InMemorySecretStore(
    cipher,
    () => new Date(nowMs).toISOString(),
    minter,
    () => nowMs,
  );
  return {
    store,
    grants,
    mintCount: () => n,
    advance: (ms: number) => {
      nowMs += ms;
    },
    setFailing: (v: boolean) => {
      failing = v;
    },
  };
}

describe("SecretCipher (AES-256-GCM)", () => {
  it("encrypt/decrypt round-trip + the ciphertext differs from the plaintext", () => {
    const enc = cipher.encrypt("sk-litellm-123");
    expect(enc.ciphertext).not.toContain("sk-litellm");
    expect(cipher.decrypt(enc)).toBe("sk-litellm-123");
  });
  it("rejects a non-32-byte key", () => {
    expect(() => aesGcmCipher(Buffer.alloc(16))).toThrow();
  });
});

// Default-ON guarantee: an ephemeral KEK cipher that works even without EVERDICT_SECRETS_KEY.
describe("generatedCipher (default-ON fallback KEK)", () => {
  it("builds a cipher that works with no key configured (round-trip)", () => {
    const c = generatedCipher();
    expect(c.decrypt(c.encrypt("sk-no-env-key"))).toBe("sk-no-env-key");
  });
  it("a different key per call — one cipher's ciphertext can't be decrypted by another", () => {
    const a = generatedCipher();
    const b = generatedCipher();
    expect(() => b.decrypt(a.encrypt("secret"))).toThrow(); // GCM auth tag mismatch
  });
});

describe("InMemorySecretStore", () => {
  it("set/list(names only)/entries(decrypted)/remove + workspace isolation", async () => {
    const s = new InMemorySecretStore(cipher, () => "2026-01-01T00:00:00Z");
    await s.set("acme", "OPENAI_API_KEY", "sk-acme");
    await s.set("acme", "OPENAI_API_BASE", "http://litellm:4000");
    await s.set("globex", "OPENAI_API_KEY", "sk-globex");

    // list has only name+meta (scope), no values — no owner given means all workspace-scoped
    expect(await s.list("acme")).toEqual([
      { name: "OPENAI_API_BASE", updatedAt: "2026-01-01T00:00:00Z", scope: "workspace", kind: "plain" },
      { name: "OPENAI_API_KEY", updatedAt: "2026-01-01T00:00:00Z", scope: "workspace", kind: "plain" },
    ]);
    // entries is the decrypted injection map
    expect(await s.entries("acme")).toEqual({ OPENAI_API_KEY: "sk-acme", OPENAI_API_BASE: "http://litellm:4000" });
    // workspace isolation: globex's key doesn't leak into acme
    expect(await s.entries("globex")).toEqual({ OPENAI_API_KEY: "sk-globex" });

    await s.remove("acme", "OPENAI_API_KEY");
    expect((await s.list("acme")).map((m) => m.name)).toEqual(["OPENAI_API_BASE"]);
  });

  it("set overwrites the same name (upsert)", async () => {
    const s = new InMemorySecretStore(cipher);
    await s.set("acme", "K", "v1");
    await s.set("acme", "K", "v2");
    expect((await s.entries("acme")).K).toBe("v2");
  });

  it("a user-scoped secret is visible only to its owner and doesn't mix into shared entries", async () => {
    const s = new InMemorySecretStore(cipher, () => "2026-01-01T00:00:00Z");
    await s.set("acme", "SHARED", "ws-val"); // shared (owner='')
    await s.set("acme", "MY_KEY", "alice-val", "alice"); // alice's personal
    await s.set("acme", "MY_KEY", "bob-val", "bob"); // bob's same-named personal secret (isolated)

    expect(await s.list("acme")).toEqual([
      { name: "SHARED", updatedAt: "2026-01-01T00:00:00Z", scope: "workspace", kind: "plain" },
    ]);
    expect(await s.list("acme", "alice")).toEqual([
      { name: "SHARED", updatedAt: "2026-01-01T00:00:00Z", scope: "workspace", kind: "plain" },
      { name: "MY_KEY", updatedAt: "2026-01-01T00:00:00Z", scope: "user", kind: "plain" },
    ]);
    expect(await s.entries("acme")).toEqual({ SHARED: "ws-val" }); // no personal included
    expect(await s.scopedEntries("acme", "alice")).toEqual({
      workspace: { SHARED: "ws-val" },
      user: { MY_KEY: "alice-val" }, // bob's is isolated
    });

    await s.remove("acme", "MY_KEY"); // owner='' (shared) — alice's personal is not deleted
    expect((await s.list("acme", "alice")).map((m) => m.name)).toContain("MY_KEY");
    await s.remove("acme", "MY_KEY", "alice");
    expect((await s.list("acme", "alice")).map((m) => m.name)).not.toContain("MY_KEY");
  });

  it("a plain secret lists as kind='plain' (no expiry)", async () => {
    const s = new InMemorySecretStore(cipher, () => "2026-01-01T00:00:00Z");
    await s.set("acme", "OPENAI_API_KEY", "sk-acme");
    expect(await s.list("acme")).toEqual([
      { name: "OPENAI_API_KEY", updatedAt: "2026-01-01T00:00:00Z", scope: "workspace", kind: "plain" },
    ]);
  });
});

const GRANT = {
  tokenUrl: "https://id.example.com/oauth/token",
  clientId: "client-1",
  clientSecret: "secret-1",
  refreshToken: "refresh-0",
  scope: "offline_access",
};

describe("InMemorySecretStore — offline tokens", () => {
  it("registers an offline token: initial mint, kind+expiry in list, entries yields the ACCESS token (never the refresh token)", async () => {
    const { store, mintCount } = offlineSetup();
    const meta = await store.setOfflineToken("acme", "MY_TOKEN", GRANT);
    expect(meta.kind).toBe("offline_token");
    expect(meta.accessTokenExpiresAt).toBe(new Date(BASE + 3_600_000).toISOString());

    expect(await store.list("acme")).toEqual([
      {
        name: "MY_TOKEN",
        updatedAt: new Date(BASE).toISOString(),
        scope: "workspace",
        kind: "offline_token",
        accessTokenExpiresAt: new Date(BASE + 3_600_000).toISOString(),
      },
    ]);
    // the injected value is a minted access token, not the stored refresh token
    expect(await store.entries("acme")).toEqual({ MY_TOKEN: "access-1" });
    // a still-fresh token is served from cache — no extra grant
    await store.entries("acme");
    expect(mintCount()).toBe(1);
  });

  it("auto-refreshes an expired access token on read and rotates the stored refresh token", async () => {
    const { store, grants, advance, mintCount } = offlineSetup();
    await store.setOfflineToken("acme", "MY_TOKEN", GRANT); // mint 1 → access-1 / refresh-1
    advance(3_600_000); // now == expiry → within the refresh skew

    expect(await store.entries("acme")).toEqual({ MY_TOKEN: "access-2" }); // re-minted
    expect(mintCount()).toBe(2);
    expect(grants[1]?.refreshToken).toBe("refresh-1"); // rotated: the refresh used the FIRST mint's new refresh token
    // the refreshed expiry is persisted (visible in list) and served from cache next read
    expect((await store.list("acme"))[0]?.accessTokenExpiresAt).toBe(
      new Date(BASE + 3_600_000 + 3_600_000).toISOString(),
    );
    expect(await store.entries("acme")).toEqual({ MY_TOKEN: "access-2" });
    expect(mintCount()).toBe(2);
  });

  it("returns the stale access token when a refresh fails — a provider outage never breaks the injection map", async () => {
    const { store, advance, setFailing } = offlineSetup();
    await store.setOfflineToken("acme", "MY_TOKEN", GRANT);
    await store.set("acme", "OTHER", "plain-value"); // an unrelated secret in the same workspace
    setFailing(true);
    advance(3_600_000); // force a refresh attempt

    // the map still resolves: the offline token falls back to its last-known access token, the plain secret is intact
    expect(await store.entries("acme")).toEqual({ MY_TOKEN: "access-1", OTHER: "plain-value" });
  });

  it("dedupes concurrent refreshes of the same token into a single grant", async () => {
    const { store, advance, mintCount } = offlineSetup();
    await store.setOfflineToken("acme", "MY_TOKEN", GRANT); // mint 1
    advance(3_600_000);
    const [a, b, c] = await Promise.all([store.entries("acme"), store.entries("acme"), store.entries("acme")]);
    expect([a.MY_TOKEN, b.MY_TOKEN, c.MY_TOKEN]).toEqual(["access-2", "access-2", "access-2"]);
    expect(mintCount()).toBe(2); // 1 initial + 1 shared refresh, not one per concurrent read
  });

  it("scopedEntries resolves an offline token to its access token in both tiers", async () => {
    const { store } = offlineSetup();
    await store.setOfflineToken("acme", "WS_TOKEN", GRANT); // shared
    await store.setOfflineToken("acme", "MY_TOKEN", GRANT, "alice"); // alice's personal
    expect(await store.scopedEntries("acme", "alice")).toEqual({
      workspace: { WS_TOKEN: "access-1" },
      user: { MY_TOKEN: "access-2" },
    });
  });

  it("overwriting an offline token with a plain value resets its kind (no stale expiry)", async () => {
    const { store } = offlineSetup();
    await store.setOfflineToken("acme", "MY_TOKEN", GRANT);
    await store.set("acme", "MY_TOKEN", "now-plain");
    expect((await store.list("acme"))[0]).toEqual({
      name: "MY_TOKEN",
      updatedAt: new Date(BASE).toISOString(),
      scope: "workspace",
      kind: "plain",
    });
    expect(await store.entries("acme")).toEqual({ MY_TOKEN: "now-plain" });
  });
});
