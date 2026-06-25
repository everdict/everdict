import { describe, expect, it } from "vitest";
import { InMemoryRunnerStore } from "./runner-store.js";

describe("InMemoryRunnerStore", () => {
  it("pair → list(owner; 토큰 없음) / resolveByToken / remove + owner 격리 + 워크스페이스 로스터", async () => {
    const s = new InMemoryRunnerStore(() => "2026-01-01T00:00:00Z");
    const alice = await s.pair({
      owner: "u-alice",
      workspace: "acme",
      label: "ho-macbook",
      os: "darwin",
      capabilities: ["repo", "browser"],
    });
    await s.pair({ owner: "u-bob", workspace: "globex", label: "bob-box" });

    const aliceMeta = {
      id: alice.meta.id,
      label: "ho-macbook",
      os: "darwin",
      capabilities: ["repo", "browser"],
      pairedAt: "2026-01-01T00:00:00Z",
    };
    // 페어링 토큰은 평문으로 한 번만 반환된다.
    expect(alice.token).toMatch(/^rnr_/);
    // list 는 owner 의 메타만 — 토큰 필드가 없다.
    const list = await s.list("u-alice");
    expect(list).toEqual([aliceMeta]);
    expect(JSON.stringify(list)).not.toContain("rnr_");

    // resolveByToken: 토큰 해시로 러너 해석(내부 전용).
    expect(await s.resolveByToken(alice.token)).toEqual({
      owner: "u-alice",
      workspace: "acme",
      runnerId: alice.meta.id,
    });
    expect(await s.resolveByToken("rnr_unknown")).toBeNull();

    // get: owner 스코프 단건(소유자 확인용). 다른 owner 로는 null(격리).
    expect(await s.get("u-alice", alice.meta.id)).toMatchObject({ label: "ho-macbook" });
    expect(await s.get("u-bob", alice.meta.id)).toBeNull();

    // owner 격리: alice 가 bob 러너를 못 본다.
    expect(await s.list("u-bob")).toHaveLength(1);

    // 워크스페이스 로스터: 페어링된 워크스페이스 기준.
    expect(await s.listByWorkspace("acme")).toEqual([aliceMeta]);
    expect(await s.listByWorkspace("globex")).toHaveLength(1);

    await s.remove("u-alice", alice.meta.id);
    expect(await s.list("u-alice")).toEqual([]);
    expect(await s.resolveByToken(alice.token)).toBeNull(); // 토큰도 무효화
    expect(await s.listByWorkspace("acme")).toEqual([]);
  });

  it("개인 소유: 같은 owner 가 여러 워크스페이스에서 페어링하면 개인 list 엔 둘 다, 각 로스터엔 하나씩", async () => {
    const s = new InMemoryRunnerStore(() => "2026-01-01T00:00:00Z");
    await s.pair({ owner: "u-alice", workspace: "acme", label: "laptop" });
    await s.pair({ owner: "u-alice", workspace: "globex", label: "desktop" });
    expect(await s.list("u-alice")).toHaveLength(2);
    expect(await s.listByWorkspace("acme")).toHaveLength(1);
    expect(await s.listByWorkspace("globex")).toHaveLength(1);
  });

  it("touch 는 lastSeenAt 을 갱신하고, 없는 러너면 no-op", async () => {
    let t = "2026-01-01T00:00:00Z";
    const s = new InMemoryRunnerStore(() => t);
    const r = await s.pair({ owner: "u-alice", workspace: "acme", label: "laptop" });
    expect((await s.list("u-alice"))[0]?.lastSeenAt).toBeUndefined();
    t = "2026-01-02T00:00:00Z";
    await s.touch("u-alice", r.meta.id);
    expect((await s.list("u-alice"))[0]?.lastSeenAt).toBe("2026-01-02T00:00:00Z");
    await s.touch("u-alice", "nope"); // 없는 러너 — 던지지 않는다
  });

  it("setCapabilities 는 capabilities 를 덮어쓰고, 없는 러너면 no-op", async () => {
    const s = new InMemoryRunnerStore(() => "2026-01-01T00:00:00Z");
    const r = await s.pair({ owner: "u-alice", workspace: "acme", label: "laptop", capabilities: ["repo"] });
    await s.setCapabilities("u-alice", r.meta.id, ["repo", "docker", "browser"]); // 러너 자가-광고(docker 감지)
    expect((await s.get("u-alice", r.meta.id))?.capabilities).toEqual(["repo", "docker", "browser"]);
    await s.setCapabilities("u-alice", "nope", ["docker"]); // 없는 러너 — 던지지 않는다
  });

  it("capabilities/os 미지정이면 빈 배열 + os 생략", async () => {
    const s = new InMemoryRunnerStore(() => "2026-01-01T00:00:00Z");
    const r = await s.pair({ owner: "u-alice", workspace: "acme", label: "minimal" });
    expect(r.meta.capabilities).toEqual([]);
    expect(r.meta.os).toBeUndefined();
  });
});
