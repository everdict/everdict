import type { AgentJob, CaseResult, GradeContext, JudgeSpec } from "@everdict/core";
import { describe, expect, it, vi } from "vitest";
import { defaultJudgeRunner } from "./judge-runner.js";

const ctx: GradeContext = {
  case: { id: "c1", env: { kind: "repo", source: { files: {} } }, task: "do x", graders: [], timeoutSec: 60, tags: [] },
  trace: [{ t: 0, kind: "llm_call", model: "m" }],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
};

const modelSpec: JudgeSpec = {
  kind: "model",
  id: "correctness",
  version: "1.0.0",
  provider: "anthropic",
  model: "claude-opus-4-8",
  rubric: "correct?",
  inputs: ["trace"],
  tags: [],
};

const harnessSpec: JudgeSpec = {
  kind: "harness",
  id: "reviewer",
  version: "1.0.0",
  harness: { id: "claude-code", version: "latest" },
  rubric: "review it",
  tags: [],
};

describe("defaultJudgeRunner", () => {
  it("model+anthropic + key present: real call (stub) → judge:<id> score", async () => {
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ content: [{ text: '{"pass":true,"score":0.8,"reason":"ok"}' }] }), {
          status: 200,
        }),
      ),
    );
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({ ANTHROPIC_API_KEY: "sk" }),
      fetchImpl: fetchImpl as typeof fetch,
    });
    const score = await runner.run(modelSpec, "acme", ctx);
    expect(score).toMatchObject({ graderId: "correctness", metric: "judge:correctness", value: 0.8, pass: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("with passThreshold, re-decides pass from the score", async () => {
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ content: [{ text: '{"pass":true,"score":0.6,"reason":"meh"}' }] }), {
          status: 200,
        }),
      ),
    );
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({ ANTHROPIC_API_KEY: "sk" }),
      fetchImpl: fetchImpl as typeof fetch,
    });
    const score = await runner.run({ ...modelSpec, passThreshold: 0.7 }, "acme", ctx);
    expect(score.pass).toBe(false); // 0.6 < 0.7
  });

  it("no key → skip score (no real call)", async () => {
    const fetchImpl = vi.fn();
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({}),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const score = await runner.run(modelSpec, "acme", ctx);
    expect(score.metric).toBe("judge:correctness");
    expect(score.detail).toContain("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("secret decryption failure (secretsFor throws): skips with the real decryption reason, not 'not configured'", async () => {
    // The secret actually exists but decryption (e.g. EVERDICT_SECRETS_KEY mismatch) throws.
    const fetchImpl = vi.fn();
    const runner = defaultJudgeRunner({
      secretsFor: async () => {
        throw new Error("EVERDICT_SECRETS_KEY mismatch");
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const score = await runner.run(modelSpec, "acme", ctx);
    expect(score.metric).toBe("judge:correctness");
    // Swallowing it with an empty-map fallback used to be misjudged as "not configured" — now the real reason shows.
    expect(score.detail).toContain("decryption failed");
    expect(score.detail).toContain("EVERDICT_SECRETS_KEY mismatch");
    expect(score.detail).not.toContain("not configured");
    expect(fetchImpl).not.toHaveBeenCalled(); // no provider call on a decryption failure
  });

  it("model+openai + key present: calls chat/completions (with the base URL applied) → score", async () => {
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: '{"pass":true,"score":0.7,"reason":"ok"}' } }] }),
          { status: 200 },
        ),
      ),
    );
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({ OPENAI_API_KEY: "sk", OPENAI_BASE_URL: "http://litellm/v1" }),
      fetchImpl: fetchImpl as typeof fetch,
    });
    const score = await runner.run({ ...modelSpec, provider: "openai", model: "gpt-5.4-mini" }, "acme", ctx);
    expect(score).toMatchObject({ metric: "judge:correctness", value: 0.7, pass: true });
    const url = fetchImpl.mock.calls[0]?.[0];
    expect(url).toMatch(/\/chat\/completions$/);
    expect(url).toContain("litellm"); // OPENAI_BASE_URL (LiteLLM, etc.) applied
  });

  it("harness kind + dispatch: spins up the referenced agent and extracts the verdict from its trace", async () => {
    const result: CaseResult = {
      caseId: "judge",
      harness: "claude-code@1",
      trace: [{ t: 0, kind: "message", role: "assistant", text: '{"pass":true,"score":0.9,"reason":"good"}' }],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
      scores: [],
    };
    const dispatch = vi.fn((_job: AgentJob) => Promise.resolve(result));
    const runner = defaultJudgeRunner({ secretsFor: async () => ({}), dispatch });
    const score = await runner.run(harnessSpec, "acme", ctx);
    expect(score).toMatchObject({ metric: "judge:reviewer", value: 0.9, pass: true });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]?.harness).toEqual({ id: "claude-code", version: "latest" });
  });

  it("harness kind + no dispatch → skip", async () => {
    const runner = defaultJudgeRunner({ secretsFor: async () => ({}) });
    const score = await runner.run(harnessSpec, "acme", ctx);
    expect(score.detail).toContain("skipped");
  });

  // --- runtime selection + co-locate (slice 1) ---
  const harnessResult: CaseResult = {
    caseId: "judge",
    harness: "claude-code@1",
    trace: [{ t: 0, kind: "message", role: "assistant", text: '{"pass":true,"score":0.5,"reason":"ok"}' }],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [],
  };

  it("harness judge: spec.runtime is dispatched as placement.target (explicit selection)", async () => {
    const dispatch = vi.fn((_job: AgentJob) => Promise.resolve(harnessResult));
    const runner = defaultJudgeRunner({ secretsFor: async () => ({}), dispatch });
    // Even with a source placement (rt-run), spec.runtime (rt-judge) wins.
    await runner.run({ ...harnessSpec, runtime: "rt-judge" }, "acme", ctx, { target: "rt-run" });
    expect(dispatch.mock.calls[0]?.[0]?.evalCase.placement).toEqual({ target: "rt-judge" });
  });

  it("harness judge: without spec.runtime, inherits the source run's placement (co-locate)", async () => {
    const dispatch = vi.fn((_job: AgentJob) => Promise.resolve(harnessResult));
    const runner = defaultJudgeRunner({ secretsFor: async () => ({}), dispatch });
    await runner.run(harnessSpec, "acme", ctx, { target: "rt-near-store", os: "linux" });
    expect(dispatch.mock.calls[0]?.[0]?.evalCase.placement).toEqual({ target: "rt-near-store", os: "linux" });
  });

  it("harness judge: with neither spec.runtime nor a source placement, no placement (default backend)", async () => {
    const dispatch = vi.fn((_job: AgentJob) => Promise.resolve(harnessResult));
    const runner = defaultJudgeRunner({ secretsFor: async () => ({}), dispatch });
    await runner.run(harnessSpec, "acme", ctx);
    expect(dispatch.mock.calls[0]?.[0]?.evalCase.placement).toBeUndefined();
  });
});
