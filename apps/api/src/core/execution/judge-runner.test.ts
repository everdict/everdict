import type { AgentJob, CaseResult, GradeContext, JudgeSpec } from "@everdict/contracts";
import { RubricSpecSchema } from "@everdict/contracts";
import { InMemoryModelRegistry, InMemoryRubricRegistry } from "@everdict/registry";
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
    const scores = await runner.run(modelSpec, "acme", ctx);
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ graderId: "correctness", metric: "judge:correctness", value: 0.8, pass: true });
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
    const [score] = await runner.run({ ...modelSpec, passThreshold: 0.7 }, "acme", ctx);
    expect(score?.pass).toBe(false); // 0.6 < 0.7
  });

  it("a multi-criteria model judge lands as judge:<id> + judge:<id>:<criterion> from ONE model call", async () => {
    const verdict =
      '{"criteria":{"accuracy":{"score":0.9,"pass":true,"reason":"right"},"style":{"score":0.5,"pass":false,"reason":"messy"}},"pass":true,"score":0.8,"reason":"overall"}';
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ content: [{ text: verdict }] }), { status: 200 })),
    );
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({ ANTHROPIC_API_KEY: "sk" }),
      fetchImpl: fetchImpl as typeof fetch,
    });
    const spec: JudgeSpec = {
      ...modelSpec,
      criteria: [
        { id: "accuracy", description: "is it right", weight: 2 },
        { id: "style", description: "is it clean", weight: 1 },
      ],
    };
    const scores = await runner.run(spec, "acme", ctx);
    expect(scores.map((s) => s.metric)).toEqual([
      "judge:correctness",
      "judge:correctness:accuracy",
      "judge:correctness:style",
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce(); // one call scores everything
  });

  it("spec.passThreshold re-decides pass for the OVERALL score only (criteria keep their own verdicts)", async () => {
    const verdict =
      '{"criteria":{"accuracy":{"score":0.9,"pass":true,"reason":"right"}},"pass":true,"score":0.6,"reason":"overall"}';
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ content: [{ text: verdict }] }), { status: 200 })),
    );
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({ ANTHROPIC_API_KEY: "sk" }),
      fetchImpl: fetchImpl as typeof fetch,
    });
    const spec: JudgeSpec = {
      ...modelSpec,
      passThreshold: 0.7,
      criteria: [{ id: "accuracy", description: "d", weight: 1 }],
    };
    const scores = await runner.run(spec, "acme", ctx);
    expect(scores[0]?.pass).toBe(false); // overall 0.6 < 0.7
    expect(scores[1]?.pass).toBe(true); // criterion untouched by the overall threshold
  });

  it("no key → skip score (no real call)", async () => {
    const fetchImpl = vi.fn();
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({}),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [score] = await runner.run(modelSpec, "acme", ctx);
    expect(score?.metric).toBe("judge:correctness");
    expect(score?.detail).toContain("skipped");
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
    const [score] = await runner.run(modelSpec, "acme", ctx);
    expect(score?.metric).toBe("judge:correctness");
    // Swallowing it with an empty-map fallback used to be misjudged as "not configured" — now the real reason shows.
    expect(score?.detail).toContain("decryption failed");
    expect(score?.detail).toContain("EVERDICT_SECRETS_KEY mismatch");
    expect(score?.detail).not.toContain("not configured");
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
    const [score] = await runner.run({ ...modelSpec, provider: "openai", model: "gpt-5.4-mini" }, "acme", ctx);
    expect(score).toMatchObject({ metric: "judge:correctness", value: 0.7, pass: true });
    const url = fetchImpl.mock.calls[0]?.[0];
    expect(url).toMatch(/\/chat\/completions$/);
    expect(url).toContain("litellm"); // OPENAI_BASE_URL (LiteLLM, etc.) applied
  });

  it("model+registered apiKeySecret: reads the model's linked secret, not the provider default (judge↔harness consistency)", async () => {
    const models = new InMemoryModelRegistry();
    await models.register("acme", {
      id: "team-opus",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
      apiKeySecret: "MY_JUDGE_KEY",
      tags: [],
    });
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ content: [{ text: '{"pass":true,"score":0.9,"reason":"ok"}' }] }), {
          status: 200,
        }),
      ),
    );
    const runner = defaultJudgeRunner({
      // ONLY the model's linked secret is set — the provider default (ANTHROPIC_API_KEY) is absent.
      secretsFor: async () => ({ MY_JUDGE_KEY: "sk-team" }),
      models,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const [score] = await runner.run({ ...modelSpec, model: "team-opus" }, "acme", ctx);
    expect(score).toMatchObject({ metric: "judge:correctness", value: 0.9, pass: true });
    expect(fetchImpl).toHaveBeenCalledOnce(); // resolved via apiKeySecret, not skipped as "not configured"
  });

  it("model+registered without apiKeySecret: falls back to the provider default key name", async () => {
    const models = new InMemoryModelRegistry();
    await models.register("acme", {
      id: "shared-opus",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
      tags: [],
    });
    const runner = defaultJudgeRunner({ secretsFor: async () => ({}), models }); // neither key set
    const [score] = await runner.run({ ...modelSpec, model: "shared-opus" }, "acme", ctx);
    expect(score?.detail).toContain("ANTHROPIC_API_KEY secret not configured");
  });

  it("model as an explicit ModelRef {ref}: resolves the registered model's baseUrl + underlying model + params + linked key", async () => {
    const models = new InMemoryModelRegistry();
    await models.register("acme", {
      id: "team-opus",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
      baseUrl: "https://litellm.acme.internal",
      apiKeySecret: "MY_JUDGE_KEY",
      params: { maxTokens: 2048 },
      tags: [],
    });
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ content: [{ text: '{"pass":true,"score":0.9,"reason":"ok"}' }] }), { status: 200 }),
      ),
    );
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({ MY_JUDGE_KEY: "sk-team" }), // ONLY the model's linked key (provider default absent)
      models,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const [score] = await runner.run({ ...modelSpec, model: { ref: "team-opus" } }, "acme", ctx);
    expect(score).toMatchObject({ metric: "judge:correctness", value: 0.9, pass: true });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://litellm.acme.internal/v1/messages"); // the model's baseUrl, not the provider default
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("claude-opus-4-8"); // the underlying model, not the ref id "team-opus"
    expect(body.max_tokens).toBe(2048); // model.params honored
  });

  it("model as an explicit ModelRef {ref} that is not registered: visible skip, never sent as a literal model name", async () => {
    const models = new InMemoryModelRegistry();
    const fetchImpl = vi.fn();
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({ ANTHROPIC_API_KEY: "sk" }), // provider default key IS set — a raw string would still call
      models,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [score] = await runner.run({ ...modelSpec, model: { ref: "ghost" } }, "acme", ctx);
    expect(score?.detail).toContain("not a registered model");
    expect(fetchImpl).not.toHaveBeenCalled(); // an explicit ref MUST resolve — no provider call
  });

  it("model as a ModelRef with a pinned version: resolves that exact version, not latest", async () => {
    const models = new InMemoryModelRegistry();
    await models.register("acme", { id: "team", version: "1.0.0", provider: "anthropic", model: "claude-opus-4-8", tags: [] });
    await models.register("acme", { id: "team", version: "2.0.0", provider: "anthropic", model: "claude-next", tags: [] });
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ content: [{ text: '{"pass":true,"score":1,"reason":"ok"}' }] }), { status: 200 }),
      ),
    );
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({ ANTHROPIC_API_KEY: "sk" }),
      models,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await runner.run({ ...modelSpec, model: { ref: "team", version: "1.0.0" } }, "acme", ctx);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe("claude-opus-4-8"); // v1.0.0's model, not v2's "claude-next"
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
    const [score] = await runner.run(harnessSpec, "acme", ctx);
    expect(score).toMatchObject({ metric: "judge:reviewer", value: 0.9, pass: true });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]?.harness).toEqual({ id: "claude-code", version: "latest" });
  });

  it("harness kind + no dispatch → skip", async () => {
    const runner = defaultJudgeRunner({ secretsFor: async () => ({}) });
    const [score] = await runner.run(harnessSpec, "acme", ctx);
    expect(score?.detail).toContain("skipped");
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

  // --- rubric refs (eval-domain-model S3): JudgeSpec.rubric may reference a registered Rubric ---
  const verdictFetch = (verdict: string) =>
    vi.fn((_u: string, _i?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ content: [{ text: verdict }] }), { status: 200 })),
    );

  it("rubric ref: the registered rubric's text/criteria/template resolve and reach the judging prompt", async () => {
    const rubrics = new InMemoryRubricRegistry();
    await rubrics.register(
      "acme",
      RubricSpecSchema.parse({
        id: "quality",
        version: "1.0.0",
        text: "the dashboard must render without errors",
        criteria: [{ id: "accuracy", description: "is it right" }],
        promptTemplate: "Custom framing. {task} {rubric} {criteria} {trace} {verdict_instruction}",
      }),
    );
    const fetchImpl = verdictFetch(
      '{"criteria":{"accuracy":{"score":0.9,"pass":true,"reason":"right"}},"pass":true,"score":0.9,"reason":"ok"}',
    );
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({ ANTHROPIC_API_KEY: "sk" }),
      fetchImpl: fetchImpl as typeof fetch,
      rubrics,
    });
    const spec: JudgeSpec = { ...modelSpec, rubric: { id: "quality", version: "latest" } };
    const scores = await runner.run(spec, "acme", ctx);
    // criteria from the rubric land as judge:<id>:<criterion> next to the overall
    expect(scores.map((s) => s.metric)).toEqual(["judge:correctness", "judge:correctness:accuracy"]);
    // the resolved rubric text + custom template reached the prompt (one real transport call)
    const body = String(fetchImpl.mock.calls[0]?.[1]?.body ?? "");
    expect(body).toContain("the dashboard must render without errors");
    expect(body).toContain("Custom framing.");
  });

  it("rubric ref: the judge's own criteria override the rubric's (more specific wins)", async () => {
    const rubrics = new InMemoryRubricRegistry();
    await rubrics.register(
      "acme",
      RubricSpecSchema.parse({
        id: "quality",
        version: "1.0.0",
        text: "base rubric",
        criteria: [{ id: "rubric-crit", description: "from the rubric" }],
      }),
    );
    const fetchImpl = verdictFetch(
      '{"criteria":{"own-crit":{"score":1,"pass":true,"reason":"ok"}},"pass":true,"score":1,"reason":"ok"}',
    );
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({ ANTHROPIC_API_KEY: "sk" }),
      fetchImpl: fetchImpl as typeof fetch,
      rubrics,
    });
    const spec: JudgeSpec = {
      ...modelSpec,
      rubric: { id: "quality", version: "latest" },
      criteria: [{ id: "own-crit", description: "from the judge", weight: 1 }],
    };
    const scores = await runner.run(spec, "acme", ctx);
    expect(scores.map((s) => s.metric)).toEqual(["judge:correctness", "judge:correctness:own-crit"]);
    const body = String(fetchImpl.mock.calls[0]?.[1]?.body ?? "");
    expect(body).toContain("own-crit");
    expect(body).not.toContain("rubric-crit");
  });

  it("rubric ref that doesn't resolve → skip score with the reason (never silent)", async () => {
    const fetchImpl = vi.fn();
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({ ANTHROPIC_API_KEY: "sk" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rubrics: new InMemoryRubricRegistry(), // registry present, rubric missing
    });
    const spec: JudgeSpec = { ...modelSpec, rubric: { id: "nope", version: "latest" } };
    const [score] = await runner.run(spec, "acme", ctx);
    expect(score?.metric).toBe("judge:correctness");
    expect(score?.detail).toContain("skipped");
    expect(score?.detail).toContain("nope");
    expect(fetchImpl).not.toHaveBeenCalled(); // no provider call on an unresolved rubric
  });

  it("rubric ref without a rubric registry dep → skip score (not configured)", async () => {
    const fetchImpl = vi.fn();
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({ ANTHROPIC_API_KEY: "sk" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const spec: JudgeSpec = { ...modelSpec, rubric: { id: "quality", version: "latest" } };
    const [score] = await runner.run(spec, "acme", ctx);
    expect(score?.detail).toContain("skipped");
    expect(score?.detail).toContain("rubric registry not configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
