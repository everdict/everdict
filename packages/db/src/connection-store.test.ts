import { describe, expect, it } from "vitest";
import { InMemoryConnectionStore } from "./connection-store.js";
import { InMemoryOAuthStateStore } from "./oauth-state-store.js";
import { aesGcmCipher } from "./secret-cipher.js";

const cipher = aesGcmCipher(Buffer.alloc(32, 9)); // 테스트용 고정 키

describe("InMemoryConnectionStore", () => {
  it("create → list(owner; 토큰 없음) / tokenFor(복호화) / remove + owner 격리 + 워크스페이스 로스터", async () => {
    const s = new InMemoryConnectionStore(cipher, () => "2026-01-01T00:00:00Z");
    const m = await s.create({
      owner: "u-alice",
      workspace: "acme",
      provider: "github",
      accountLabel: "octocat",
      scopes: ["repo", "read:packages"],
      accessToken: "gho_secret_alice",
    });
    await s.create({
      owner: "u-bob",
      workspace: "globex",
      provider: "github",
      accountLabel: "globex-bot",
      scopes: ["repo"],
      accessToken: "gho_secret_bob",
    });

    const aliceMeta = {
      id: m.id,
      provider: "github",
      accountLabel: "octocat",
      scopes: ["repo", "read:packages"],
      connectedAt: "2026-01-01T00:00:00Z",
    };
    // list 는 owner 의 메타만 — 토큰 필드가 없다.
    const list = await s.list("u-alice");
    expect(list).toEqual([aliceMeta]);
    expect(JSON.stringify(list)).not.toContain("gho_");

    // tokenFor 는 복호화 — 내부 전용(owner 키).
    expect(await s.tokenFor("u-alice", m.id)).toEqual({ accessToken: "gho_secret_alice" });
    // owner 격리: alice 가 bob 연결을 못 본다.
    expect(await s.list("u-bob")).toHaveLength(1);
    expect(await s.tokenFor("u-bob", m.id)).toBeNull();

    // 워크스페이스 로스터: 만들어진 워크스페이스 기준(읽기 전용). 토큰은 미노출.
    expect(await s.listByWorkspace("acme")).toEqual([aliceMeta]);
    expect(await s.listByWorkspace("globex")).toHaveLength(1);

    await s.remove("u-alice", m.id);
    expect(await s.list("u-alice")).toEqual([]);
    expect(await s.tokenFor("u-alice", m.id)).toBeNull();
    expect(await s.listByWorkspace("acme")).toEqual([]); // 로스터에서도 사라짐
  });

  it("개인 소유: 같은 owner 가 여러 워크스페이스에서 연결하면 개인 list 엔 둘 다, 각 로스터엔 하나씩", async () => {
    const s = new InMemoryConnectionStore(cipher, () => "2026-01-01T00:00:00Z");
    await s.create({
      owner: "u-alice",
      workspace: "acme",
      provider: "github",
      accountLabel: "octocat",
      scopes: [],
      accessToken: "a1",
    });
    await s.create({
      owner: "u-alice",
      workspace: "globex",
      provider: "mattermost",
      accountLabel: "alice",
      scopes: [],
      accessToken: "a2",
    });
    expect(await s.list("u-alice")).toHaveLength(2); // 개인은 어느 워크스페이스 연결이든 다 본다
    expect(await s.listByWorkspace("acme")).toHaveLength(1);
    expect(await s.listByWorkspace("globex")).toHaveLength(1);
  });

  it("refresh token + host + expiresAt 을 보존한다", async () => {
    const s = new InMemoryConnectionStore(cipher);
    const m = await s.create({
      owner: "u-alice",
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
    expect(await s.tokenFor("u-alice", m.id)).toEqual({
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
