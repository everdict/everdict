import { describe, expect, it } from "vitest";
import { aesGcmCipher, generatedCipher } from "./secret-cipher.js";
import { InMemorySecretStore } from "./secret-store.js";

const cipher = aesGcmCipher(Buffer.alloc(32, 7)); // fixed 32-byte key for tests

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
      { name: "OPENAI_API_BASE", updatedAt: "2026-01-01T00:00:00Z", scope: "workspace" },
      { name: "OPENAI_API_KEY", updatedAt: "2026-01-01T00:00:00Z", scope: "workspace" },
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

    expect(await s.list("acme")).toEqual([{ name: "SHARED", updatedAt: "2026-01-01T00:00:00Z", scope: "workspace" }]);
    expect(await s.list("acme", "alice")).toEqual([
      { name: "SHARED", updatedAt: "2026-01-01T00:00:00Z", scope: "workspace" },
      { name: "MY_KEY", updatedAt: "2026-01-01T00:00:00Z", scope: "user" },
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
});
