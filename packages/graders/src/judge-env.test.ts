import { safeGrade } from "@everdict/application-execution";
import { type GradeContext, type TraceEvent, toScores } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { judgeFromEnv, makeGradersFromEnv } from "./judge-env.js";

const OBS_NONE = { kind: "unobserved", reason: "no_environment" } as const;

const ctx = (text: string): GradeContext => ({
  deadlineAt: Date.now() + 60_000, // one shared deadline for the case's whole scoring phase
  observations: OBS_NONE,
  case: { id: "c", env: { kind: "browser", startUrl: "https://x" }, task: "q", graders: [], timeoutSec: 1, tags: [] },
  trace: [{ t: 0, kind: "message", role: "assistant", text }] as TraceEvent[],
  snapshot: { kind: "browser", url: "https://x", dom: text, console: [] },
});

describe("judgeFromEnv", () => {
  it("undefined without EVERDICT_JUDGE_MODEL (judge disabled)", () => {
    expect(judgeFromEnv({})).toBeUndefined();
    expect(judgeFromEnv({ OPENAI_API_KEY: "k" })).toBeUndefined(); // no model
  });
  it("configures a Judge when the openai key + model are present", () => {
    expect(judgeFromEnv({ EVERDICT_JUDGE_MODEL: "m", OPENAI_API_KEY: "k" })).toBeDefined();
  });
  it("the anthropic provider requires ANTHROPIC_API_KEY", () => {
    expect(judgeFromEnv({ EVERDICT_JUDGE_MODEL: "m", EVERDICT_JUDGE_PROVIDER: "anthropic" })).toBeUndefined();
    expect(
      judgeFromEnv({ EVERDICT_JUDGE_MODEL: "m", EVERDICT_JUDGE_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }),
    ).toBeDefined();
  });
});

describe("makeGradersFromEnv", () => {
  it("judge not configured: judge spec becomes a skip score grader, the rest stay normal (eval doesn't die)", async () => {
    const graders = makeGradersFromEnv([{ id: "steps" }, { id: "judge", config: { rubric: "r" } }], {});
    expect(graders.map((g) => g.id)).toEqual(["steps", "judge"]);
    const [judgeScore] = toScores((await graders[1]?.grade(ctx("hi"))) ?? []);
    // An unconstructable grader is UNMEASURED — no value, no pass, so it cannot enter a mean or a passRate.
    expect(judgeScore).toEqual({
      graderId: "judge",
      metric: "judge",
      status: "unmeasured",
      reason: "unsupported",
      retryable: false,
      detail: expect.stringContaining("skipped"),
    });
  });
  // The dispatch path does not read the grader's own return value: every score passes the collection boundary
  // (`safeGrade` → `sanitizeScore`), which refuses a judge-family metric from a producer that does not own the
  // judge verdict. The skip grader stands in for the judge, so it must survive that boundary as the unmeasured
  // row it wrote. Observed RED before the fix: the row arrived `status: "invalid"`, detail "'judge' belongs to
  // the judge family, which only a judge may produce".
  it("an unconfigured judge settles as unmeasured through the collection boundary, not as a forged metric", async () => {
    const graders = makeGradersFromEnv([{ id: "judge", config: { rubric: "r" } }], {});
    expect(graders).toHaveLength(1);
    const scores = await safeGrade(graders[0] as (typeof graders)[number], ctx("hi"));
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ graderId: "judge", metric: "judge", status: "unmeasured" });
  });
  it("judge configured: a real JudgeGrader with the injected Judge (transport made deterministic by fetch injection)", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: '{"pass":true,"score":1,"reason":"ok"}' } }] };
      },
      async text() {
        return "";
      },
    })) as unknown as typeof fetch;
    // Since openaiComplete can't be directly injected with fetchImpl (only via env), here we only check whether the judge is configured;
    // the actual judging is verified in the judge-grading live test. (When a judge is configured via env, the judge spec becomes a JudgeGrader.)
    void fetchImpl;
    const graders = makeGradersFromEnv([{ id: "judge", config: { id: "wv-judge", rubric: "r" } }], {
      EVERDICT_JUDGE_MODEL: "m",
      OPENAI_API_KEY: "k",
    });
    expect(graders[0]?.id).toBe("wv-judge"); // a real JudgeGrader (config.id), not a skip
  });
});
