import type { GradeContext, JudgeSpec } from "@assay/core";
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

describe("defaultJudgeRunner", () => {
  it("model+anthropic + 키 있음: 실제 호출(stub) → judge:<id> 점수", async () => {
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

  it("passThreshold 있으면 score 로 pass 재판정", async () => {
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

  it("키 없음 → skip 점수(실제 호출 없음)", async () => {
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

  it("harness 종류 → skip(다음 증분)", async () => {
    const runner = defaultJudgeRunner({ secretsFor: async () => ({ ANTHROPIC_API_KEY: "sk" }) });
    const harnessSpec: JudgeSpec = {
      kind: "harness",
      id: "reviewer",
      version: "1.0.0",
      harness: { id: "claude-code", version: "latest" },
      tags: [],
    };
    const score = await runner.run(harnessSpec, "acme", ctx);
    expect(score.detail).toContain("skipped");
  });
});
