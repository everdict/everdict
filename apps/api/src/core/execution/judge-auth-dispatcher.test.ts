import type { Dispatcher } from "@everdict/backends";
import type { CaseJob, CaseResult } from "@everdict/contracts";
import { InMemoryModelRegistry } from "@everdict/registry";
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
  const seen: CaseJob[] = [];
  const inner: Dispatcher = {
    async dispatch(job) {
      seen.push(job);
      return result;
    },
  };
  return { inner, seen };
}

const job = (over: Partial<CaseJob> = {}, target = "nomad-local"): CaseJob => ({
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

  it("self-hosted lanes receive the resolved credential like managed ones (parity with harness secrets)", async () => {
    // Regression: the old self:* exemption shipped code-judge jobs to the runner with no key at all — the judge
    // script called the provider unauthenticated (401) even though the workspace key existed.
    const { inner, seen } = innerSpy();
    const d = new JudgeAuthDispatcher({
      inner,
      scopedSecretsFor: tiers({ workspace: { OPENAI_API_KEY: "ws-key", OPENAI_BASE_URL: "http://litellm" }, user: {} }),
    });
    for (const target of ["self", "self:runner-1", "self:ws", "self:ws:build-1"]) {
      await d.dispatch(job({}, target));
    }
    expect(seen).toHaveLength(4);
    expect(seen.every((j) => j.judgeAuth?.apiKey === "ws-key" && j.judgeAuth.baseUrl === "http://litellm")).toBe(true);
  });

  it("a self-hosted lane with NO resolvable key dispatches WITHOUT judgeAuth (own-pays machine env), no fail-fast", async () => {
    const { inner, seen } = innerSpy();
    const d = new JudgeAuthDispatcher({ inner, scopedSecretsFor: tiers({ workspace: {}, user: {} }) });
    for (const target of ["self", "self:runner-1", "self:ws", "self:ws:build-1"]) {
      await d.dispatch(job({}, target)); // no key anywhere — still no throw, the runner's own env judges
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

  it("a judge model that is a registered {ref}: resolves the Model's underlying id/baseUrl + its linked key, and rewrites job.judge", async () => {
    const models = new InMemoryModelRegistry();
    await models.register("acme", {
      id: "team-4o",
      version: "1.0.0",
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://litellm.acme",
      apiKeySecret: "TEAM_JUDGE_KEY",
      tags: [],
    });
    const { inner, seen } = innerSpy();
    const d = new JudgeAuthDispatcher({
      inner,
      models,
      scopedSecretsFor: tiers({ workspace: { TEAM_JUDGE_KEY: "sk-team" }, user: {} }), // ONLY the model's linked key
    });
    await d.dispatch(job({ judge: { model: { ref: "team-4o" } } }));
    expect(seen[0]?.judge).toEqual({ provider: "openai", model: "gpt-4o" }); // rewritten to the underlying model + resolved provider
    expect(seen[0]?.judgeAuth).toEqual({ apiKey: "sk-team", baseUrl: "https://litellm.acme" }); // the model's key + baseUrl
  });

  it("an explicit {ref} to an unregistered model fails fast (config), never dispatched", async () => {
    const { inner, seen } = innerSpy();
    const d = new JudgeAuthDispatcher({
      inner,
      models: new InMemoryModelRegistry(),
      scopedSecretsFor: tiers({ workspace: { OPENAI_API_KEY: "k" }, user: {} }),
    });
    await expect(d.dispatch(job({ judge: { model: { ref: "ghost" } } }))).rejects.toThrow(
      /no such model is registered/,
    );
    expect(seen).toHaveLength(0);
  });

  it("self-hosted {ref}: the model resolves AND its linked key ships with the job (baseUrl no longer lost)", async () => {
    const models = new InMemoryModelRegistry();
    await models.register("acme", {
      id: "team-4o",
      version: "1.0.0",
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://litellm.acme",
      apiKeySecret: "TEAM_JUDGE_KEY",
      tags: [],
    });
    const { inner, seen } = innerSpy();
    const d = new JudgeAuthDispatcher({
      inner,
      models,
      scopedSecretsFor: tiers({ workspace: { TEAM_JUDGE_KEY: "sk" }, user: {} }),
    });
    await d.dispatch(job({ judge: { model: { ref: "team-4o" } } }, "self:ws"));
    expect(seen[0]?.judge).toEqual({ provider: "openai", model: "gpt-4o" }); // resolved for the runner
    // Regression: the exemption also dropped the model's baseUrl (it rides judgeAuth) — a proxy-bound key on the
    // runner's machine was sent to the real provider endpoint, another 401 shape.
    expect(seen[0]?.judgeAuth).toEqual({ apiKey: "sk", baseUrl: "https://litellm.acme" });
  });
});
