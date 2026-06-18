import { describe, expect, it } from "vitest";
import { aesGcmCipher } from "./secret-cipher.js";
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

describe("InMemorySecretStore", () => {
  it("set/list(이름만)/entries(복호화)/remove + 워크스페이스 격리", async () => {
    const s = new InMemorySecretStore(cipher, () => "2026-01-01T00:00:00Z");
    await s.set("acme", "OPENAI_API_KEY", "sk-acme");
    await s.set("acme", "OPENAI_API_BASE", "http://litellm:4000");
    await s.set("globex", "OPENAI_API_KEY", "sk-globex");

    // list 는 이름+메타만(값 없음)
    expect(await s.list("acme")).toEqual([
      { name: "OPENAI_API_BASE", updatedAt: "2026-01-01T00:00:00Z" },
      { name: "OPENAI_API_KEY", updatedAt: "2026-01-01T00:00:00Z" },
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
});
