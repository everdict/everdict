import { ForbiddenError } from "@assay/core";
import { InMemoryWorkspaceSettingsStore } from "@assay/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MattermostCommandService } from "./mattermost-command-service.js";

const TOKEN = "s3cret-cmd-token";

describe("MattermostCommandService — 인바운드 검증 + 디스패치", () => {
  let settings: InMemoryWorkspaceSettingsStore;
  let submit: ReturnType<typeof vi.fn>;
  let svc: MattermostCommandService;

  beforeEach(async () => {
    settings = new InMemoryWorkspaceSettingsStore();
    await settings.set("acme", {
      mattermost: { host: "https://mm.corp.io", botTokenSecretName: "MM_BOT", commandTokenSecretName: "MM_CMD" },
    });
    submit = vi.fn(async () => ({ id: "sc-1" }));
    svc = new MattermostCommandService({
      settings,
      secretsFor: async () => ({ MM_CMD: TOKEN }),
      submitScorecard: submit as never,
      leaderboard: async () => [
        { label: "codex@1", value: "0.900" },
        { label: "claude@2", value: "0.850" },
      ],
      webBaseUrl: "https://assay.example.com",
    });
  });

  // --- 검증(보안): fail-closed ---
  it("commandTokenSecretName 미설정 워크스페이스는 Forbidden(인바운드 비활성)", async () => {
    await settings.set("beta", { mattermost: { host: "https://mm.corp.io", botTokenSecretName: "MM_BOT" } });
    await expect(svc.handleCommand("beta", { token: TOKEN, text: "status" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("mattermost 미설정 워크스페이스는 Forbidden", async () => {
    await expect(svc.handleCommand("nope", { token: TOKEN, text: "status" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("토큰 불일치는 Forbidden(상수시간 비교)", async () => {
    await expect(svc.handleCommand("acme", { token: "wrong", text: "status" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("토큰 없음은 Forbidden", async () => {
    await expect(svc.handleCommand("acme", { text: "status" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  // --- 디스패치 ---
  it("status → 연결 확인 응답(ephemeral)", async () => {
    const r = await svc.handleCommand("acme", { token: TOKEN, text: "status" });
    expect(r.response_type).toBe("ephemeral");
    expect(r.text).toContain("acme");
  });

  it("run <harness> <dataset> → 스코어카드 발사 + in_channel 응답(링크 포함)", async () => {
    const r = await svc.handleCommand("acme", { token: TOKEN, text: "run codex pinch", userName: "alice" });
    expect(submit).toHaveBeenCalledWith("acme", {
      dataset: "pinch",
      harness: "codex",
      submittedBy: "mattermost:alice",
    });
    expect(r.response_type).toBe("in_channel");
    expect(r.text).toContain("sc-1");
    expect(r.text).toContain("https://assay.example.com/acme/scorecards/sc-1");
  });

  it("run 인자 부족 → 사용법 안내(발사 안 함)", async () => {
    const r = await svc.handleCommand("acme", { token: TOKEN, text: "run codex" });
    expect(submit).not.toHaveBeenCalled();
    expect(r.text).toContain("사용법");
  });

  it("leaderboard <dataset> → 순위 포맷", async () => {
    const r = await svc.handleCommand("acme", { token: TOKEN, text: "leaderboard pinch" });
    expect(r.response_type).toBe("in_channel");
    expect(r.text).toContain("1. `codex@1` — 0.900");
    expect(r.text).toContain("2. `claude@2` — 0.850");
  });

  it("help/미지원 → 명령어 안내", async () => {
    expect((await svc.handleCommand("acme", { token: TOKEN, text: "" })).text).toContain("run");
    expect((await svc.handleCommand("acme", { token: TOKEN, text: "wat" })).text).toContain("run");
  });

  // --- 버튼(액션) ---
  it("rerun 액션 → context 로 재발사(검증 후)", async () => {
    const r = await svc.handleAction("acme", {
      token: TOKEN,
      action: "rerun",
      context: { dataset: "pinch", harness: "codex", userName: "bob" },
    });
    expect(submit).toHaveBeenCalledWith("acme", { dataset: "pinch", harness: "codex", submittedBy: "mattermost:bob" });
    expect(r.ephemeral_text).toContain("sc-1");
  });

  it("액션도 토큰 검증 fail-closed", async () => {
    await expect(
      svc.handleAction("acme", { token: "wrong", action: "rerun", context: { dataset: "d", harness: "h" } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
