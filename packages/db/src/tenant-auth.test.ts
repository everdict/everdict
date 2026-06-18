import { describe, expect, it } from "vitest";
import { InMemoryTenantKeyStore, generateKey, hashKey, issueKey, keyStoreAuth } from "./tenant-auth.js";

describe("tenant auth", () => {
  it("발급된 키로 테넌트를 인증한다", async () => {
    const store = new InMemoryTenantKeyStore();
    const key = await issueKey(store, "acme");
    expect(key.startsWith("ak_")).toBe(true);
    const auth = keyStoreAuth(store);
    expect(await auth.authenticate(key)).toBe("acme");
  });

  it("잘못된/빈 키는 undefined", async () => {
    const store = new InMemoryTenantKeyStore();
    await issueKey(store, "acme");
    const auth = keyStoreAuth(store);
    expect(await auth.authenticate("ak_wrong")).toBeUndefined();
    expect(await auth.authenticate("")).toBeUndefined();
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
