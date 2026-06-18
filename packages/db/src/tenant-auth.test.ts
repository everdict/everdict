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
});
