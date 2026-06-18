import { UpstreamError } from "@assay/core";
import type { Judge, JudgeVerdict } from "./judge.js";

// 모델 호출 프리미티브 — 프롬프트 → 원문 텍스트. 전송(transport)을 판정 로직과 분리(테스트 시 주입).
export type JudgeCompletion = (prompt: string) => Promise<string>;

const MAX_CHARS = 6000; // 트레이스/DOM 은 클 수 있으므로 컨텍스트 보호용으로 절단.

interface JudgeInput {
  task: string;
  trace?: unknown;
  dom?: string;
  rubric?: string;
}

// 판정 프롬프트 — task + rubric + (트레이스/DOM)로 LLM/VLM 에게 JSON 판정을 요구.
function buildPrompt(input: JudgeInput): string {
  const trace = input.trace ? JSON.stringify(input.trace).slice(0, MAX_CHARS) : "(none)";
  return [
    "You are a strict evaluation judge for an AI agent's run. Judge ONLY from the evidence below.",
    `TASK:\n${input.task}`,
    input.rubric ? `RUBRIC:\n${input.rubric}` : "",
    input.dom ? `FINAL DOM (truncated):\n${input.dom.slice(0, MAX_CHARS)}` : "",
    `EXECUTION TRACE (JSON, truncated):\n${trace}`,
    'Respond with ONLY a JSON object, no prose: {"pass": boolean, "score": number in [0,1], "reason": string}.',
  ]
    .filter(Boolean)
    .join("\n\n");
}

// 모델 응답에서 JSON 판정을 추출(앞뒤 산문 허용). 형식 오류는 UpstreamError(외부 의존성 탓).
function parseVerdict(text: string): JudgeVerdict {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m)
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { text: text.slice(0, 200) },
      "judge 응답에서 JSON 판정을 찾지 못했습니다.",
    );
  let obj: unknown;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    throw new UpstreamError("UPSTREAM_ERROR", { text: m[0].slice(0, 200) }, "judge 판정 JSON 파싱에 실패했습니다.");
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.score !== "number" || typeof o.reason !== "string")
    throw new UpstreamError("UPSTREAM_ERROR", {}, "judge 판정 형식이 올바르지 않습니다(score/reason).");
  const score = Math.max(0, Math.min(1, o.score));
  const pass = typeof o.pass === "boolean" ? o.pass : score >= 0.5;
  return { pass, score, reason: o.reason };
}

// model judge — JudgeCompletion(모델 호출)을 받아 Judge 로. 전송은 anthropicComplete 등으로 주입.
export function modelJudge(complete: JudgeCompletion): Judge {
  return {
    async judge(input) {
      const text = await complete(buildPrompt(input));
      return parseVerdict(text);
    },
  };
}

// Anthropic Messages API 전송(fetch). 외부 실패는 UpstreamError 로 remap(모니터링이 우리를 탓하게).
export function anthropicComplete(cfg: {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}): JudgeCompletion {
  const f = cfg.fetchImpl ?? fetch;
  const base = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  return async (prompt) => {
    let res: Response;
    try {
      res = await f(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: cfg.maxTokens ?? 1024,
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch (err) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        {},
        `judge 모델 호출 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `judge 모델 ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = json.content?.[0]?.text;
    if (typeof text !== "string") throw new UpstreamError("UPSTREAM_ERROR", {}, "judge 모델 응답에 텍스트가 없습니다.");
    return text;
  };
}
