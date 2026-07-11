import type { Dispatcher } from "@everdict/backends";
import type { AgentJob, CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { JudgeAuthDispatcher, type ScopedSecretTiers } from "./judge-auth-dispatcher.js";

const result: CaseResult = {
  caseId: "c1",
  harness: "scripted@0",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
};

function innerSpy() {
  const seen: AgentJob[] = [];
  const inner: Dispatcher = {
    async dispatch(job) {
      seen.push(job);
      return result;
    },
  };
  return { inner, seen };
}

const job = (over: Partial<AgentJob> = {}, target = "nomad-local"): AgentJob => ({
  evalCase: {
    id: "c1",
    env: { kind: "prompt" },
    task: "t",
    graders: [{ id: "judge" }],
    timeoutSec: 60,
    tags: [],
    placement: { target },
  },
  harness: { id: "scripted", version: "0" },
  tenant: "acme",
  submittedBy: "alice",
  judge: { provider: "openai", model: "gpt-5.4-mini" },
  ...over,
});

const tiers =
  (t: ScopedSecretTiers) =>
  async (_tenant: string, _subject?: string): Promise<ScopedSecretTiers> =>
    t;

describe("JudgeAuthDispatcher (per-job judge credential resolution)", () => {
  it("attaches the WORKSPACE tier key (and base url) — the team key wins over the submitter's personal one", async () => {
    const { inner, seen } = innerSpy();
    const d = new JudgeAuthDispatcher({
      inner,
      scopedSecretsFor: tiers({
        workspace: { OPENAI_API_KEY: "ws-key", OPENAI_BASE_URL: "http://litellm" },
        user: { OPENAI_API_KEY: "personal-key" },
      }),
    });
    await d.dispatch(job());
    expect(seen[0]?.judgeAuth).toEqual({ apiKey: "ws-key", baseUrl: "http://litellm" });
  });

  it("falls back to the submitter's PERSONAL key when the workspace tier has none (solo-user judging)", async () => {
    const { inner, seen } = innerSpy();
    const d = new JudgeAuthDispatcher({
      inner,
      scopedSecretsFor: tiers({ workspace: {}, user: { OPENAI_API_KEY: "personal-key" } }),
    });
    await d.dispatch(job());
    expect(seen[0]?.judgeAuth).toEqual({ apiKey: "personal-key" });
  });

  it("resolves the anthropic provider's key names", async () => {
    const { inner, seen } = innerSpy();
    const d = new JudgeAuthDispatcher({
      inner,
      scopedSecretsFor: tiers({
        workspace: { ANTHROPIC_API_KEY: "ak", ANTHROPIC_BASE_URL: "http://claude" },
        user: {},
      }),
    });
    await d.dispatch(job({ judge: { provider: "anthropic", model: "claude-opus-4-8" } }));
    expect(seen[0]?.judgeAuth).toEqual({ apiKey: "ak", baseUrl: "http://claude" });
  });

  it("a judge with NO resolvable key on a managed target fails fast (config), before any compute is spent", async () => {
    const { inner, seen } = innerSpy();
    const d = new JudgeAuthDispatcher({ inner, scopedSecretsFor: tiers({ workspace: {}, user: {} }) });
    await expect(d.dispatch(job())).rejects.toThrow(/no OPENAI_API_KEY secret is resolvable/);
    expect(seen).toHaveLength(0); // inner never reached — the case was not dispatched
  });

  it("self-hosted lanes are exempt — the runner judges with its own env (own-pays), keys never shipped", async () => {
    const { inner, seen } = innerSpy();
    const d = new JudgeAuthDispatcher({ inner, scopedSecretsFor: tiers({ workspace: {}, user: {} }) });
    for (const target of ["self", "self:runner-1", "self:ws", "self:ws:build-1"]) {
      await d.dispatch(job({}, target)); // no key anywhere — still no throw, no judgeAuth
    }
    expect(seen).toHaveLength(4);
    expect(seen.every((j) => j.judgeAuth === undefined)).toBe(true);
  });

  it("passes through untouched when no judge is configured or judgeAuth is already present", async () => {
    const { inner, seen } = innerSpy();
    const d = new JudgeAuthDispatcher({ inner, scopedSecretsFor: tiers({ workspace: {}, user: {} }) });
    const withoutJudge = job();
    withoutJudge.judge = undefined;
    await d.dispatch(withoutJudge);
    const preResolved = job({ judgeAuth: { apiKey: "already" } });
    await d.dispatch(preResolved);
    expect(seen[0]?.judgeAuth).toBeUndefined();
    expect(seen[1]?.judgeAuth).toEqual({ apiKey: "already" });
  });
});
