import { describe, expect, it } from "vitest";
import { InMemoryConnectionStore } from "./connection-store.js";
import { InMemoryOAuthStateStore } from "./oauth-state-store.js";
import { aesGcmCipher } from "./secret-cipher.js";

const cipher = aesGcmCipher(Buffer.alloc(32, 9)); // 테스트용 고정 키

describe("InMemoryConnectionStore", () => {
  it("create → list(토큰 없음) / tokenFor(복호화) / remove + 워크스페이스 격리", async () => {
    const s = new InMemoryConnectionStore(cipher, () => "2026-01-01T00:00:00Z");
    const m = await s.create({
      workspace: "acme",
      provider: "github",
      accountLabel: "octocat",
      scopes: ["repo", "read:packages"],
      accessToken: "gho_secret_acme",
    });
    await s.create({
      workspace: "globex",
      provider: "github",
      accountLabel: "globex-bot",
      scopes: ["repo"],
      accessToken: "gho_secret_globex",
    });

    // list 는 메타만 — 토큰 필드가 없다.
    const list = await s.list("acme");
    expect(list).toEqual([
      {
        id: m.id,
        provider: "github",
        accountLabel: "octocat",
        scopes: ["repo", "read:packages"],
        connectedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(JSON.stringify(list)).not.toContain("gho_");

    // tokenFor 는 복호화 — 내부 전용.
    expect(await s.tokenFor("acme", m.id)).toEqual({ accessToken: "gho_secret_acme" });
    // 워크스페이스 격리: acme 가 globex 연결을 못 본다.
    expect(await s.list("globex")).toHaveLength(1);
    expect(await s.tokenFor("globex", m.id)).toBeNull();

    await s.remove("acme", m.id);
    expect(await s.list("acme")).toEqual([]);
    expect(await s.tokenFor("acme", m.id)).toBeNull();
  });

  it("refresh token + host + expiresAt 을 보존한다", async () => {
    const s = new InMemoryConnectionStore(cipher);
    const m = await s.create({
      workspace: "acme",
      provider: "mattermost",
      host: "https://mm.acme.io",
      accountLabel: "alice",
      scopes: [],
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: "2026-02-01T00:00:00Z",
    });
    expect(m.host).toBe("https://mm.acme.io");
    expect(await s.tokenFor("acme", m.id)).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: "2026-02-01T00:00:00Z",
    });
  });
});

describe("InMemoryOAuthStateStore (1회용 pending state)", () => {
  it("put → take 는 1회만 성공(2번째는 null)", async () => {
    const s = new InMemoryOAuthStateStore(() => "2026-01-01T00:00:00Z");
    await s.put("st_1", { workspace: "acme", provider: "github", createdBy: "alice" }, "2026-01-01T00:10:00Z");
    expect(await s.take("st_1")).toEqual({ workspace: "acme", provider: "github", createdBy: "alice" });
    expect(await s.take("st_1")).toBeNull(); // 소비됨
  });

  it("만료된 state 는 null (소비도 됨)", async () => {
    const s = new InMemoryOAuthStateStore(() => "2026-01-01T01:00:00Z");
    await s.put(
      "st_2",
      { workspace: "acme", provider: "github", host: "ghe.acme.io", createdBy: "bob" },
      "2026-01-01T00:10:00Z",
    );
    expect(await s.take("st_2")).toBeNull(); // 이미 만료
  });

  it("없는 state 는 null", async () => {
    const s = new InMemoryOAuthStateStore();
    expect(await s.take("nope")).toBeNull();
  });

  it("self-hosted host/clientId/clientSecretName 을 운반한다(콜백 자격증명 재해석용)", async () => {
    const s = new InMemoryOAuthStateStore(() => "2026-01-01T00:00:00Z");
    const p = {
      workspace: "acme",
      provider: "github-enterprise",
      host: "https://ghe.acme.io",
      clientId: "Iv1.cafe",
      clientSecretName: "GHE_OAUTH_SECRET",
      createdBy: "alice",
    };
    await s.put("st_3", p, "2026-01-01T00:10:00Z");
    expect(await s.take("st_3")).toEqual(p);
  });
});
