import { MattermostCommandService } from "@everdict/application-control";
import { ForbiddenError } from "@everdict/contracts";
import { InMemoryWorkspaceSettingsStore } from "@everdict/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "s3cret-cmd-token";

describe("MattermostCommandService — inbound verification + dispatch", () => {
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
      webBaseUrl: "https://everdict.example.com",
    });
  });

  // --- verification (security): fail-closed ---
  it("a workspace with no commandTokenSecretName is Forbidden (inbound disabled)", async () => {
    await settings.set("beta", { mattermost: { host: "https://mm.corp.io", botTokenSecretName: "MM_BOT" } });
    await expect(svc.handleCommand("beta", { token: TOKEN, text: "status" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a workspace with no mattermost configured is Forbidden", async () => {
    await expect(svc.handleCommand("nope", { token: TOKEN, text: "status" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a token mismatch is Forbidden (constant-time compare)", async () => {
    await expect(svc.handleCommand("acme", { token: "wrong", text: "status" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a missing token is Forbidden", async () => {
    await expect(svc.handleCommand("acme", { text: "status" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  // --- dispatch ---
  it("status → connection-check response (ephemeral)", async () => {
    const r = await svc.handleCommand("acme", { token: TOKEN, text: "status" });
    expect(r.response_type).toBe("ephemeral");
    expect(r.text).toContain("acme");
  });

  it("run <harness> <dataset> → fires a scorecard + in_channel response (with link)", async () => {
    const r = await svc.handleCommand("acme", { token: TOKEN, text: "run codex pinch", userName: "alice" });
    expect(submit).toHaveBeenCalledWith("acme", {
      dataset: "pinch",
      harness: "codex",
      submittedBy: "mattermost:alice",
    });
    expect(r.response_type).toBe("in_channel");
    expect(r.text).toContain("sc-1");
    expect(r.text).toContain("https://everdict.example.com/acme/scorecards/sc-1");
  });

  it("run with too few args → usage guidance (does not fire)", async () => {
    const r = await svc.handleCommand("acme", { token: TOKEN, text: "run codex" });
    expect(submit).not.toHaveBeenCalled();
    expect(r.text).toContain("Usage");
  });

  it("leaderboard <dataset> → ranking format", async () => {
    const r = await svc.handleCommand("acme", { token: TOKEN, text: "leaderboard pinch" });
    expect(r.response_type).toBe("in_channel");
    expect(r.text).toContain("1. `codex@1` — 0.900");
    expect(r.text).toContain("2. `claude@2` — 0.850");
  });

  it("help/unsupported → command guidance", async () => {
    expect((await svc.handleCommand("acme", { token: TOKEN, text: "" })).text).toContain("run");
    expect((await svc.handleCommand("acme", { token: TOKEN, text: "wat" })).text).toContain("run");
  });

  // --- buttons (actions) ---
  it("rerun action → re-fires from context (after verification)", async () => {
    const r = await svc.handleAction("acme", {
      token: TOKEN,
      action: "rerun",
      context: { dataset: "pinch", harness: "codex", userName: "bob" },
    });
    expect(submit).toHaveBeenCalledWith("acme", { dataset: "pinch", harness: "codex", submittedBy: "mattermost:bob" });
    expect(r.ephemeral_text).toContain("sc-1");
  });

  it("actions also fail-closed on token verification", async () => {
    await expect(
      svc.handleAction("acme", { token: "wrong", action: "rerun", context: { dataset: "d", harness: "h" } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
