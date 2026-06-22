import { describe, expect, it } from "vitest";
import { InMemoryTenantKeyStore, generateKey, hashKey, issueKey } from "./tenant-auth.js";

describe("tenant key store", () => {
  it("발급된 키 해시로 테넌트를 조회한다", async () => {
    const store = new InMemoryTenantKeyStore();
    const key = await issueKey(store, "acme");
    expect(key.startsWith("ak_")).toBe(true);
    expect(await store.tenantForHash(hashKey(key))).toBe("acme");
  });

  it("잘못된 키 해시는 undefined", async () => {
    const store = new InMemoryTenantKeyStore();
    await issueKey(store, "acme");
    expect(await store.tenantForHash(hashKey("ak_wrong"))).toBeUndefined();
  });

  it("평문이 아니라 해시만 저장된다", async () => {
    const store = new InMemoryTenantKeyStore();
    const key = await issueKey(store, "acme");
    expect(await store.tenantForHash(hashKey(key))).toBe("acme"); // 해시로 조회됨
    expect(await store.tenantForHash(key)).toBeUndefined(); // 평문으로는 안 됨
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

  it("revoke 후에는 tenantForHash 로 더 이상 해석되지 않는다", async () => {
    const store = new InMemoryTenantKeyStore();
    const key = await issueKey(store, "acme");
    const [meta] = await store.list("acme");
    await store.revoke("acme", meta?.id ?? "");
    expect(await store.tenantForHash(hashKey(key))).toBeUndefined();
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
    expect(await store.tenantForHash(hashKey(globexKey))).toBe("globex");
  });
});
