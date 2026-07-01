import { type TraceEvent, UpstreamError } from "@assay/core";
import type { Judge, JudgeImage, JudgeVerdict } from "./judge.js";

// 모델 호출 프리미티브 — (프롬프트[, 이미지]) → 원문 텍스트. 전송(transport)을 판정 로직과 분리(테스트 시 주입).
// 이미지가 주어지면 비전 모델(VLM)로 멀티모달 전송한다(os-use 스크린샷 판정 등).
export type JudgeCompletion = (prompt: string, image?: JudgeImage) => Promise<string>;

const MAX_CHARS = 6000; // 트레이스/DOM 은 클 수 있으므로 컨텍스트 보호용으로 절단.

interface JudgeInput {
  task: string;
  trace?: TraceEvent[];
  dom?: string;
  screenshot?: JudgeImage;
  rubric?: string;
}

// 에이전트 최종 답변 = 트레이스의 마지막 assistant message 텍스트. 최종 답변은 보통 트레이스 배열의 맨 끝에 있어
// JSON.stringify(trace).slice(0, MAX) 로 절단하면 잘려나간다 → judge 가 "최종 답변 없음"으로 오판. 전용 섹션으로 뽑는다.
function finalAnswerOf(trace: TraceEvent[] | undefined): string | undefined {
  if (!trace) return undefined;
  const messages = trace.filter((e): e is Extract<TraceEvent, { kind: "message" }> => e.kind === "message");
  const assistant = messages.filter((m) => m.role === "assistant");
  return assistant[assistant.length - 1]?.text;
}

// 판정 프롬프트 — task + rubric + (최종 답변/트레이스/DOM/스크린샷)로 LLM/VLM 에게 JSON 판정을 요구.
function buildPrompt(input: JudgeInput): string {
  // 최종 답변은 트레이스 JSON 절단과 무관하게 전용 섹션으로 항상 온전히 포함(자체 상한으로 slice) — 절단으로 인한 오판 방지.
  const finalAnswer = finalAnswerOf(input.trace);
  const trace = input.trace ? JSON.stringify(input.trace).slice(0, MAX_CHARS) : "(none)";
  return [
    "You are a strict evaluation judge for an AI agent's run. Judge ONLY from the evidence below.",
    `TASK:\n${input.task}`,
    input.rubric ? `RUBRIC:\n${input.rubric}` : "",
    input.dom ? `FINAL DOM (truncated):\n${input.dom.slice(0, MAX_CHARS)}` : "",
    input.screenshot
      ? "A SCREENSHOT of the final UI/desktop state is attached. Judge whether it shows the task's goal state."
      : "",
    finalAnswer ? `AGENT FINAL ANSWER:\n${finalAnswer.slice(0, MAX_CHARS)}` : "",
    // 트레이스 JSON 은 절단될 수 있으므로, 잘려서 최종 답변이 안 보여도 위 섹션을 보라고 명시.
    `EXECUTION TRACE (JSON, truncated${finalAnswer ? "; see AGENT FINAL ANSWER above" : ""}):\n${trace}`,
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
      const text = await complete(buildPrompt(input), input.screenshot);
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
  return async (prompt, image) => {
    // 이미지가 있으면 멀티모달 content(텍스트 + base64 이미지 블록) — Anthropic Messages 비전 포맷.
    const content = image
      ? [
          { type: "text", text: prompt },
          { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } },
        ]
      : prompt;
    let res: Response;
    try {
      res = await f(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: cfg.maxTokens ?? 1024,
          messages: [{ role: "user", content }],
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

// OpenAI Chat Completions 전송(fetch). OpenAI-호환이면 LiteLLM 프록시 등도 baseUrl 로 지원.
export function openaiComplete(cfg: {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}): JudgeCompletion {
  const f = cfg.fetchImpl ?? fetch;
  const base = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  return async (prompt, image) => {
    // 이미지가 있으면 멀티모달 content(텍스트 + data-URL image_url) — OpenAI-호환 비전 포맷(LiteLLM 프록시 포함).
    const content = image
      ? [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } },
        ]
      : prompt;
    let res: Response;
    try {
      res = await f(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          ...(cfg.maxTokens ? { max_tokens: cfg.maxTokens } : {}),
          messages: [{ role: "user", content }],
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
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new UpstreamError("UPSTREAM_ERROR", {}, "judge 모델 응답에 텍스트가 없습니다.");
    return text;
  };
}

// 트레이스에서 에이전트의 산출 텍스트를 모은다(assistant 메시지 우선, 없으면 전체 메시지). harness judge 의 verdict 추출용.
export function traceToText(trace: TraceEvent[]): string {
  const messages = trace.filter((e): e is Extract<TraceEvent, { kind: "message" }> => e.kind === "message");
  const assistant = messages.filter((m) => m.role === "assistant");
  return (assistant.length > 0 ? assistant : messages).map((m) => m.text).join("\n");
}

// harness judge 전송 — 참조 하니스(에이전트)를 판정 프롬프트로 띄우고, 그 트레이스의 출력 텍스트를 verdict 로.
// model judge 와 동일한 modelJudge(전송) 구조로 통일 — 전송만 "에이전트 디스패치"로 바뀐다.
export function harnessComplete(cfg: { dispatch: (task: string) => Promise<TraceEvent[]> }): JudgeCompletion {
  return async (prompt) => traceToText(await cfg.dispatch(prompt));
}
