import { describe, expect, it } from "vitest";
import { InMemoryTenantKeyStore, generateKey, hashKey, issueKey } from "./tenant-auth.js";

describe("tenant key store", () => {
  it("발급된 키 해시로 테넌트를 조회한다", async () => {
    const store = new InMemoryTenantKeyStore();
    const key = await issueKey(store, "acme");
    expect(key.startsWith("ak_")).toBe(true);
    expect((await store.resolveByHash(hashKey(key)))?.tenant).toBe("acme");
  });

  it("잘못된 키 해시는 undefined", async () => {
    const store = new InMemoryTenantKeyStore();
    await issueKey(store, "acme");
    expect(await store.resolveByHash(hashKey("ak_wrong"))).toBeUndefined();
  });

  it("평문이 아니라 해시만 저장된다", async () => {
    const store = new InMemoryTenantKeyStore();
    const key = await issueKey(store, "acme");
    expect((await store.resolveByHash(hashKey(key)))?.tenant).toBe("acme"); // 해시로 조회됨
    expect(await store.resolveByHash(key)).toBeUndefined(); // 평문으로는 안 됨
  });

  it("키마다 다르다", () => {
    expect(generateKey()).not.toBe(generateKey());
  });

  it("list 는 prefix/메타만 노출하고 평문·해시는 절대 반환하지 않는다", async () => {
    const store = new InMemoryTenantKeyStore();
    const key = await issueKey(store, "acme", "ci-bot");
    const [meta] = await store.list("acme");
    expect(meta?.prefix).toBe(key.slice(0, 12)); // ak_ + 처음 9자(식별 힌트)
    expect(meta?.label).toBe("ci-bot");
    expect(typeof meta?.id).toBe("string");
    // 어떤 필드도 평문/해시와 같지 않다
    const values = Object.values(meta ?? {});
    expect(values).not.toContain(key);
    expect(values).not.toContain(hashKey(key));
  });

  it("revoke 후에는 resolveByHash 로 더 이상 해석되지 않는다", async () => {
    const store = new InMemoryTenantKeyStore();
    const key = await issueKey(store, "acme");
    const [meta] = await store.list("acme");
    await store.revoke("acme", meta?.id ?? "");
    expect(await store.resolveByHash(hashKey(key))).toBeUndefined();
    expect(await store.list("acme")).toEqual([]);
  });

  it("cross-workspace 격리: 다른 워크스페이스의 키는 list 에 안 보이고 revoke 도 no-op", async () => {
    const store = new InMemoryTenantKeyStore();
    await issueKey(store, "acme");
    const globexKey = await issueKey(store, "globex");
    const [globexMeta] = await store.list("globex");
    expect((await store.list("acme")).every((m) => m.id !== globexMeta?.id)).toBe(true);
    // acme 가 globex 의 id 를 취소 시도해도 무효(존재 누출 없음)
    await store.revoke("acme", globexMeta?.id ?? "");
    expect((await store.resolveByHash(hashKey(globexKey)))?.tenant).toBe("globex");
  });

  it("scopes 를 저장하고 resolveByHash·list 로 그대로 돌려준다", async () => {
    const store = new InMemoryTenantKeyStore();
    const key = await issueKey(store, "acme", "read-only", ["read"]);
    expect((await store.resolveByHash(hashKey(key)))?.scopes).toEqual(["read"]);
    const [meta] = await store.list("acme");
    expect(meta?.scopes).toEqual(["read"]);
  });

  it("scopes 미지정(레거시/full access)이면 undefined = 무제한", async () => {
    const store = new InMemoryTenantKeyStore();
    const key = await issueKey(store, "acme");
    expect((await store.resolveByHash(hashKey(key)))?.scopes).toBeUndefined();
    const [meta] = await store.list("acme");
    expect(meta?.scopes).toBeUndefined();
  });

  it("개인 키: owner 를 저장하고, list(owner)/revoke(owner)는 그 유저 것만 다룬다", async () => {
    const store = new InMemoryTenantKeyStore();
    const aliceKey = await issueKey(store, "acme", "alice-key", undefined, "alice");
    await issueKey(store, "acme", "bob-key", undefined, "bob");
    const machineKey = await issueKey(store, "acme", "ci"); // owner=""(머신 키)

    // resolveByHash 는 owner 를 그대로 — 인증이 발급자로 해석하게 한다.
    expect((await store.resolveByHash(hashKey(aliceKey)))?.owner).toBe("alice");
    expect((await store.resolveByHash(hashKey(machineKey)))?.owner).toBe("");

    // list(owner): alice 것만(bob·머신 키 제외). list(): 전체(머신 키 관리용).
    expect((await store.list("acme", "alice")).map((m) => m.label)).toEqual(["alice-key"]);
    expect((await store.list("acme")).length).toBe(3);

    // revoke(owner): 남의 id 는 no-op(존재 누출 없음).
    const [bobMeta] = await store.list("acme", "bob");
    await store.revoke("acme", bobMeta?.id ?? "", "alice"); // alice 가 bob 키 취소 시도 → 무효
    expect((await store.list("acme", "bob")).length).toBe(1);
    await store.revoke("acme", bobMeta?.id ?? "", "bob"); // 본인 취소 → 유효
    expect((await store.list("acme", "bob")).length).toBe(0);
  });
});
