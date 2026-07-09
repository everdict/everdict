import { type GradeContext, type TraceEvent, toScores } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { judgeFromEnv, makeGradersFromEnv } from "./judge-env.js";

const ctx = (text: string): GradeContext => ({
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
    expect(judgeScore?.pass).toBeUndefined(); // skip = pass undefined
    expect(String(judgeScore?.detail)).toContain("skipped");
    expect(judgeScore?.metric).toBe("judge");
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
