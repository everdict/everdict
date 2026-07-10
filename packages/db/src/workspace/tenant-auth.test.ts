import { generateKey, hashKey } from "@everdict/application-control";
import { describe, expect, it } from "vitest";
import { InMemoryTenantKeyStore, issueKey } from "./tenant-auth.js";

describe("tenant key store", () => {
  it("looks up the tenant by the issued key's hash", async () => {
    const store = new InMemoryTenantKeyStore();
    const key = await issueKey(store, "acme");
    expect(key.startsWith("ak_")).toBe(true);
    expect((await store.resolveByHash(hashKey(key)))?.tenant).toBe("acme");
  });

  it("a wrong key hash is undefined", async () => {
    const store = new InMemoryTenantKeyStore();
    await issueKey(store, "acme");
    expect(await store.resolveByHash(hashKey("ak_wrong"))).toBeUndefined();
  });

  it("stores only the hash, not the plaintext", async () => {
    const store = new InMemoryTenantKeyStore();
    const key = await issueKey(store, "acme");
    expect((await store.resolveByHash(hashKey(key)))?.tenant).toBe("acme"); // resolved by hash
    expect(await store.resolveByHash(key)).toBeUndefined(); // not by plaintext
  });

  it("differs per key", () => {
    expect(generateKey()).not.toBe(generateKey());
  });

  it("list exposes only prefix/meta and never returns the plaintext·hash", async () => {
    const store = new InMemoryTenantKeyStore();
    const key = await issueKey(store, "acme", "ci-bot");
    const [meta] = await store.list("acme");
    expect(meta?.prefix).toBe(key.slice(0, 12)); // ak_ + first 9 chars (identification hint)
    expect(meta?.label).toBe("ci-bot");
    expect(typeof meta?.id).toBe("string");
    // no field equals the plaintext/hash
    const values = Object.values(meta ?? {});
    expect(values).not.toContain(key);
    expect(values).not.toContain(hashKey(key));
  });

  it("after revoke, resolveByHash no longer resolves it", async () => {
    const store = new InMemoryTenantKeyStore();
    const key = await issueKey(store, "acme");
    const [meta] = await store.list("acme");
    await store.revoke("acme", meta?.id ?? "");
    expect(await store.resolveByHash(hashKey(key))).toBeUndefined();
    expect(await store.list("acme")).toEqual([]);
  });

  it("cross-workspace isolation: another workspace's key is not shown in list and revoke is a no-op", async () => {
    const store = new InMemoryTenantKeyStore();
    await issueKey(store, "acme");
    const globexKey = await issueKey(store, "globex");
    const [globexMeta] = await store.list("globex");
    expect((await store.list("acme")).every((m) => m.id !== globexMeta?.id)).toBe(true);
    // acme trying to revoke globex's id has no effect (no existence leak)
    await store.revoke("acme", globexMeta?.id ?? "");
    expect((await store.resolveByHash(hashKey(globexKey)))?.tenant).toBe("globex");
  });

  it("stores scopes and returns them as-is via resolveByHash·list", async () => {
    const store = new InMemoryTenantKeyStore();
    const key = await issueKey(store, "acme", "read-only", ["read"]);
    expect((await store.resolveByHash(hashKey(key)))?.scopes).toEqual(["read"]);
    const [meta] = await store.list("acme");
    expect(meta?.scopes).toEqual(["read"]);
  });

  it("if scopes is unset (legacy/full access), undefined = unrestricted", async () => {
    const store = new InMemoryTenantKeyStore();
    const key = await issueKey(store, "acme");
    expect((await store.resolveByHash(hashKey(key)))?.scopes).toBeUndefined();
    const [meta] = await store.list("acme");
    expect(meta?.scopes).toBeUndefined();
  });

  it("personal key: stores owner, and list(owner)/revoke(owner) handle only that user's keys", async () => {
    const store = new InMemoryTenantKeyStore();
    const aliceKey = await issueKey(store, "acme", "alice-key", undefined, "alice");
    await issueKey(store, "acme", "bob-key", undefined, "bob");
    const machineKey = await issueKey(store, "acme", "ci"); // owner="" (machine key)

    // resolveByHash returns owner as-is — lets auth resolve it as the issuer.
    expect((await store.resolveByHash(hashKey(aliceKey)))?.owner).toBe("alice");
    expect((await store.resolveByHash(hashKey(machineKey)))?.owner).toBe("");

    // list(owner): alice's only (excludes bob·machine key). list(): everything (for machine-key management).
    expect((await store.list("acme", "alice")).map((m) => m.label)).toEqual(["alice-key"]);
    expect((await store.list("acme")).length).toBe(3);

    // revoke(owner): another's id is a no-op (no existence leak).
    const [bobMeta] = await store.list("acme", "bob");
    await store.revoke("acme", bobMeta?.id ?? "", "alice"); // alice trying to revoke bob's key → no effect
    expect((await store.list("acme", "bob")).length).toBe(1);
    await store.revoke("acme", bobMeta?.id ?? "", "bob"); // revoking one's own → effective
    expect((await store.list("acme", "bob")).length).toBe(0);
  });
});
