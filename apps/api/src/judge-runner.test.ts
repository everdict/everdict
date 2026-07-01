import type { AgentJob, CaseResult, GradeContext, JudgeSpec } from "@assay/core";
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

  it("시크릿 복호화 실패(secretsFor throw): '미설정'이 아니라 실제 복호화 사유로 skip", async () => {
    // 시크릿이 실제로 있는데 복호화(ASSAY_SECRETS_KEY 불일치 등)가 throw 나는 상황.
    const fetchImpl = vi.fn();
    const runner = defaultJudgeRunner({
      secretsFor: async () => {
        throw new Error("ASSAY_SECRETS_KEY mismatch");
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const score = await runner.run(modelSpec, "acme", ctx);
    expect(score.metric).toBe("judge:correctness");
    // 빈 맵 폴백으로 삼키면 "미설정"으로 오판됐었다 — 이제 실제 사유가 드러난다.
    expect(score.detail).toContain("복호화 실패");
    expect(score.detail).toContain("ASSAY_SECRETS_KEY mismatch");
    expect(score.detail).not.toContain("미설정");
    expect(fetchImpl).not.toHaveBeenCalled(); // 복호화 실패면 프로바이더 호출 없음
  });

  it("model+openai + 키 있음: chat/completions(베이스 URL 적용) 호출 → 점수", async () => {
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
    expect(url).toContain("litellm"); // OPENAI_BASE_URL(LiteLLM 등) 적용
  });

  it("harness 종류 + dispatch: 참조 에이전트를 띄워 그 트레이스에서 verdict 추출", async () => {
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

  it("harness 종류 + dispatch 없음 → skip", async () => {
    const runner = defaultJudgeRunner({ secretsFor: async () => ({}) });
    const score = await runner.run(harnessSpec, "acme", ctx);
    expect(score.detail).toContain("skipped");
  });

  // --- 런타임 선택 + co-locate (slice 1) ---
  const harnessResult: CaseResult = {
    caseId: "judge",
    harness: "claude-code@1",
    trace: [{ t: 0, kind: "message", role: "assistant", text: '{"pass":true,"score":0.5,"reason":"ok"}' }],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [],
  };

  it("harness judge: spec.runtime 이 placement.target 으로 디스패치된다(명시 선택)", async () => {
    const dispatch = vi.fn((_job: AgentJob) => Promise.resolve(harnessResult));
    const runner = defaultJudgeRunner({ secretsFor: async () => ({}), dispatch });
    // 산출 placement(rt-run)가 있어도 spec.runtime(rt-judge)이 우선한다.
    await runner.run({ ...harnessSpec, runtime: "rt-judge" }, "acme", ctx, { target: "rt-run" });
    expect(dispatch.mock.calls[0]?.[0]?.evalCase.placement).toEqual({ target: "rt-judge" });
  });

  it("harness judge: spec.runtime 없으면 산출 run 의 placement 를 상속한다(co-locate)", async () => {
    const dispatch = vi.fn((_job: AgentJob) => Promise.resolve(harnessResult));
    const runner = defaultJudgeRunner({ secretsFor: async () => ({}), dispatch });
    await runner.run(harnessSpec, "acme", ctx, { target: "rt-near-store", os: "linux" });
    expect(dispatch.mock.calls[0]?.[0]?.evalCase.placement).toEqual({ target: "rt-near-store", os: "linux" });
  });

  it("harness judge: spec.runtime 도 산출 placement 도 없으면 placement 없음(기본 백엔드)", async () => {
    const dispatch = vi.fn((_job: AgentJob) => Promise.resolve(harnessResult));
    const runner = defaultJudgeRunner({ secretsFor: async () => ({}), dispatch });
    await runner.run(harnessSpec, "acme", ctx);
    expect(dispatch.mock.calls[0]?.[0]?.evalCase.placement).toBeUndefined();
  });
});
