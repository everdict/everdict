import process from "node:process";
import { type Grader, type GraderSpec, JUDGE_MODEL_ENV, JUDGE_PROVIDER_ENV, type Score } from "@everdict/contracts";
import { transportFor } from "@everdict/llm";
import type { Judge } from "./judge.js";
import { makeGraders } from "./make-graders.js";
import { modelJudge, transportComplete } from "./model-judge.js";

type Env = Record<string, string | undefined>;

// Configures a Judge from env to run per-case judge graders on the dispatch path (agent/run, service-backend).
// Model transport is the same as harness/judge (incl. OpenAI-compatible LiteLLM). The control plane injects tenant secrets as alloc env:
//   EVERDICT_JUDGE_MODEL    = the judging model (required — judge disabled without it)
//   EVERDICT_JUDGE_PROVIDER = openai (default) | anthropic
//   OPENAI_API_KEY / OPENAI_BASE_URL   or   ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
export function judgeFromEnv(env: Env = process.env): Judge | undefined {
  const model = env[JUDGE_MODEL_ENV];
  if (!model) return undefined;
  const provider = (env[JUDGE_PROVIDER_ENV] ?? "openai") === "anthropic" ? "anthropic" : "openai";
  const apiKey = provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
  if (!apiKey) return undefined;
  const baseUrl = provider === "anthropic" ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL;
  const transport = transportFor({ provider, apiKey, ...(baseUrl ? { baseUrl } : {}) });
  return modelJudge(transportComplete(transport, { model }));
}

// A skip grader that keeps an unrunnable grader from silently vanishing from the scores (same philosophy as judge-runner: reason in detail).
export function skipGrader(id: string, metric: string, reason: string): Grader {
  return {
    id,
    async grade(): Promise<Score> {
      return { graderId: id, metric, value: 0, pass: undefined, detail: `skipped: ${reason}` };
    },
  };
}

// For the dispatch path: GraderSpec[] → Grader[] including the judge grader, using the Judge from env.
// If a judge is configured, inject it for real judging; otherwise replace only the judge spec with a skip score grader (so a normal eval doesn't die).
export function makeGradersFromEnv(specs: GraderSpec[], env: Env = process.env): Grader[] {
  const judge = judgeFromEnv(env);
  if (judge) return makeGraders(specs, { judge });
  const out: Grader[] = [];
  for (const s of specs) {
    if (s.id === "judge") {
      const id = typeof s.config?.id === "string" ? s.config.id : "judge";
      out.push(skipGrader(id, "judge", "judge model not configured (EVERDICT_JUDGE_MODEL + key)"));
    } else {
      out.push(...makeGraders([s]));
    }
  }
  return out;
}
