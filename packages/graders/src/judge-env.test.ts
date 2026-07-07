import type { GradeContext, TraceEvent } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { judgeFromEnv, makeGradersFromEnv } from "./judge-env.js";

const ctx = (text: string): GradeContext => ({
  case: { id: "c", env: { kind: "browser", startUrl: "https://x" }, task: "q", graders: [], timeoutSec: 1, tags: [] },
  trace: [{ t: 0, kind: "message", role: "assistant", text }] as TraceEvent[],
  snapshot: { kind: "browser", url: "https://x", dom: text, console: [] },
});

describe("judgeFromEnv", () => {
  it("EVERDICT_JUDGE_MODEL 없으면 undefined(judge 비활성)", () => {
    expect(judgeFromEnv({})).toBeUndefined();
    expect(judgeFromEnv({ OPENAI_API_KEY: "k" })).toBeUndefined(); // 모델 없음
  });
  it("openai 키+모델 있으면 Judge 구성", () => {
    expect(judgeFromEnv({ EVERDICT_JUDGE_MODEL: "m", OPENAI_API_KEY: "k" })).toBeDefined();
  });
  it("anthropic provider 는 ANTHROPIC_API_KEY 필요", () => {
    expect(judgeFromEnv({ EVERDICT_JUDGE_MODEL: "m", EVERDICT_JUDGE_PROVIDER: "anthropic" })).toBeUndefined();
    expect(
      judgeFromEnv({ EVERDICT_JUDGE_MODEL: "m", EVERDICT_JUDGE_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }),
    ).toBeDefined();
  });
});

describe("makeGradersFromEnv", () => {
  it("judge 미구성: judge 스펙은 skip 점수 grader 로, 나머지는 정상(eval 안 죽음)", async () => {
    const graders = makeGradersFromEnv([{ id: "steps" }, { id: "judge", config: { rubric: "r" } }], {});
    expect(graders.map((g) => g.id)).toEqual(["steps", "judge"]);
    const judgeScore = await graders[1]?.grade(ctx("hi"));
    expect(judgeScore?.pass).toBeUndefined(); // skip = pass 미정
    expect(String(judgeScore?.detail)).toContain("skipped");
    expect(judgeScore?.metric).toBe("judge");
  });
  it("judge 구성: 주입된 Judge 로 실제 JudgeGrader (전송은 fetch 주입으로 결정적)", async () => {
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
    // openaiComplete 가 fetchImpl 를 쓰도록 env 경유가 아닌 직접 주입은 불가하므로, 여기선 judge 구성 여부만 확인하고
    // 실제 판정은 judge-grading 라이브에서 검증. (env 로 judge 가 구성되면 judge 스펙이 JudgeGrader 가 된다.)
    void fetchImpl;
    const graders = makeGradersFromEnv([{ id: "judge", config: { id: "wv-judge", rubric: "r" } }], {
      EVERDICT_JUDGE_MODEL: "m",
      OPENAI_API_KEY: "k",
    });
    expect(graders[0]?.id).toBe("wv-judge"); // skip 이 아니라 실제 JudgeGrader(config.id)
  });
});
