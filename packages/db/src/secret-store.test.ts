import { describe, expect, it } from "vitest";
import { aesGcmCipher, generatedCipher } from "./secret-cipher.js";
import { InMemorySecretStore } from "./secret-store.js";

const cipher = aesGcmCipher(Buffer.alloc(32, 7)); // 테스트용 고정 32바이트 키

describe("SecretCipher (AES-256-GCM)", () => {
  it("암복호화 왕복 + 암호문은 평문과 다르다", () => {
    const enc = cipher.encrypt("sk-litellm-123");
    expect(enc.ciphertext).not.toContain("sk-litellm");
    expect(cipher.decrypt(enc)).toBe("sk-litellm-123");
  });
  it("32바이트가 아니면 거부", () => {
    expect(() => aesGcmCipher(Buffer.alloc(16))).toThrow();
  });
});

// 기본 ON 보장: ASSAY_SECRETS_KEY 없이도 동작하는 임시 KEK cipher.
describe("generatedCipher (기본 ON 폴백 KEK)", () => {
  it("키 설정 없이도 동작하는 cipher 를 만든다(왕복)", () => {
    const c = generatedCipher();
    expect(c.decrypt(c.encrypt("sk-no-env-key"))).toBe("sk-no-env-key");
  });
  it("호출마다 다른 키 — 한 cipher 의 암호문을 다른 cipher 가 복호화하지 못한다", () => {
    const a = generatedCipher();
    const b = generatedCipher();
    expect(() => b.decrypt(a.encrypt("secret"))).toThrow(); // GCM auth tag 불일치
  });
});

describe("InMemorySecretStore", () => {
  it("set/list(이름만)/entries(복호화)/remove + 워크스페이스 격리", async () => {
    const s = new InMemorySecretStore(cipher, () => "2026-01-01T00:00:00Z");
    await s.set("acme", "OPENAI_API_KEY", "sk-acme");
    await s.set("acme", "OPENAI_API_BASE", "http://litellm:4000");
    await s.set("globex", "OPENAI_API_KEY", "sk-globex");

    // list 는 이름+메타(스코프)만(값 없음) — owner 미지정은 전부 workspace 스코프
    expect(await s.list("acme")).toEqual([
      { name: "OPENAI_API_BASE", updatedAt: "2026-01-01T00:00:00Z", scope: "workspace" },
      { name: "OPENAI_API_KEY", updatedAt: "2026-01-01T00:00:00Z", scope: "workspace" },
    ]);
    // entries 는 복호화된 주입용 맵
    expect(await s.entries("acme")).toEqual({ OPENAI_API_KEY: "sk-acme", OPENAI_API_BASE: "http://litellm:4000" });
    // 워크스페이스 격리: globex 키가 acme 로 새지 않음
    expect(await s.entries("globex")).toEqual({ OPENAI_API_KEY: "sk-globex" });

    await s.remove("acme", "OPENAI_API_KEY");
    expect((await s.list("acme")).map((m) => m.name)).toEqual(["OPENAI_API_BASE"]);
  });

  it("set 은 같은 이름을 덮어쓴다(업서트)", async () => {
    const s = new InMemorySecretStore(cipher);
    await s.set("acme", "K", "v1");
    await s.set("acme", "K", "v2");
    expect((await s.entries("acme")).K).toBe("v2");
  });

  it("유저 스코프 시크릿은 본인만 보이고 공유 entries 에 안 섞인다", async () => {
    const s = new InMemorySecretStore(cipher, () => "2026-01-01T00:00:00Z");
    await s.set("acme", "SHARED", "ws-val"); // 공유(owner='')
    await s.set("acme", "MY_KEY", "alice-val", "alice"); // alice 개인
    await s.set("acme", "MY_KEY", "bob-val", "bob"); // bob 의 동명 개인 시크릿(격리)

    expect(await s.list("acme")).toEqual([{ name: "SHARED", updatedAt: "2026-01-01T00:00:00Z", scope: "workspace" }]);
    expect(await s.list("acme", "alice")).toEqual([
      { name: "SHARED", updatedAt: "2026-01-01T00:00:00Z", scope: "workspace" },
      { name: "MY_KEY", updatedAt: "2026-01-01T00:00:00Z", scope: "user" },
    ]);
    expect(await s.entries("acme")).toEqual({ SHARED: "ws-val" }); // 개인 미포함
    expect(await s.scopedEntries("acme", "alice")).toEqual({
      workspace: { SHARED: "ws-val" },
      user: { MY_KEY: "alice-val" }, // bob 것 격리
    });

    await s.remove("acme", "MY_KEY"); // owner=''(공유) — alice 개인은 안 지워짐
    expect((await s.list("acme", "alice")).map((m) => m.name)).toContain("MY_KEY");
    await s.remove("acme", "MY_KEY", "alice");
    expect((await s.list("acme", "alice")).map((m) => m.name)).not.toContain("MY_KEY");
  });
});
