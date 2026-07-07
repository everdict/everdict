import process from "node:process";
import { type Grader, type GraderSpec, JUDGE_MODEL_ENV, JUDGE_PROVIDER_ENV, type Score } from "@everdict/core";
import type { Judge } from "./judge.js";
import { makeGraders } from "./make-graders.js";
import { anthropicComplete, modelJudge, openaiComplete } from "./model-judge.js";

type Env = Record<string, string | undefined>;

// dispatch 경로(agent/run, service-backend)에서 per-case judge grader 를 실행하기 위한 Judge 를 env 로 구성.
// 모델 전송은 harness/judge 와 동일(OpenAI-호환 LiteLLM 포함). 컨트롤플레인이 테넌트 시크릿을 alloc env 로 주입:
//   EVERDICT_JUDGE_MODEL    = 판정 모델 (필수 — 없으면 judge 비활성)
//   EVERDICT_JUDGE_PROVIDER = openai(기본) | anthropic
//   OPENAI_API_KEY / OPENAI_BASE_URL   또는   ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
export function judgeFromEnv(env: Env = process.env): Judge | undefined {
  const model = env[JUDGE_MODEL_ENV];
  if (!model) return undefined;
  if ((env[JUDGE_PROVIDER_ENV] ?? "openai") === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) return undefined;
    return modelJudge(
      anthropicComplete({ apiKey, model, ...(env.ANTHROPIC_BASE_URL ? { baseUrl: env.ANTHROPIC_BASE_URL } : {}) }),
    );
  }
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return undefined;
  return modelJudge(
    openaiComplete({ apiKey, model, ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}) }),
  );
}

// 실행 불가한 grader 를 점수에서 조용히 사라지지 않게 하는 skip grader(judge-runner 와 동일 철학: 사유를 detail 에).
export function skipGrader(id: string, metric: string, reason: string): Grader {
  return {
    id,
    async grade(): Promise<Score> {
      return { graderId: id, metric, value: 0, pass: undefined, detail: `skipped: ${reason}` };
    },
  };
}

// dispatch 경로용: env 의 Judge 로 judge grader 까지 포함해 GraderSpec[] → Grader[].
// judge 가 구성돼 있으면 주입해 실제 판정, 미구성이면 judge 스펙만 skip 점수 grader 로 대체(일반 eval 이 죽지 않게).
export function makeGradersFromEnv(specs: GraderSpec[], env: Env = process.env): Grader[] {
  const judge = judgeFromEnv(env);
  if (judge) return makeGraders(specs, { judge });
  const out: Grader[] = [];
  for (const s of specs) {
    if (s.id === "judge") {
      const id = typeof s.config?.id === "string" ? s.config.id : "judge";
      out.push(skipGrader(id, "judge", "judge 모델 미설정(EVERDICT_JUDGE_MODEL + 키)"));
    } else {
      out.push(...makeGraders([s]));
    }
  }
  return out;
}
