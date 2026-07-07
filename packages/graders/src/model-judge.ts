import { type TraceEvent, UpstreamError } from "@everdict/core";
import type { Judge, JudgeImage, JudgeVerdict } from "./judge.js";

// Model-call primitive — (prompt[, image]) → raw text. Separates transport from judging logic (injected in tests).
// If an image is given, sends multimodally to a vision model (VLM) (e.g. os-use screenshot judging).
export type JudgeCompletion = (prompt: string, image?: JudgeImage) => Promise<string>;

const MAX_CHARS = 6000; // Trace/DOM can be large, so truncate to protect the context.

interface JudgeInput {
  task: string;
  trace?: TraceEvent[];
  dom?: string;
  screenshot?: JudgeImage;
  rubric?: string;
}

// Agent final answer = the text of the last assistant message in the trace. The final answer is usually at the very end of the trace array,
// so truncating with JSON.stringify(trace).slice(0, MAX) cuts it off → the judge misjudges it as "no final answer". Extract it into a dedicated section.
function finalAnswerOf(trace: TraceEvent[] | undefined): string | undefined {
  if (!trace) return undefined;
  const messages = trace.filter((e): e is Extract<TraceEvent, { kind: "message" }> => e.kind === "message");
  const assistant = messages.filter((m) => m.role === "assistant");
  return assistant[assistant.length - 1]?.text;
}

// Judging prompt — asks the LLM/VLM for a JSON verdict from task + rubric + (final answer/trace/DOM/screenshot).
function buildPrompt(input: JudgeInput): string {
  // The final answer is always fully included in a dedicated section regardless of trace JSON truncation (sliced with its own cap) — avoids misjudgment from truncation.
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
    // Since the trace JSON may be truncated, tell it to look at the section above even if the final answer is cut off.
    `EXECUTION TRACE (JSON, truncated${finalAnswer ? "; see AGENT FINAL ANSWER above" : ""}):\n${trace}`,
    'Respond with ONLY a JSON object, no prose: {"pass": boolean, "score": number in [0,1], "reason": string}.',
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Extracts the JSON verdict from the model response (surrounding prose allowed). Format errors → UpstreamError (blame the external dependency).
function parseVerdict(text: string): JudgeVerdict {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m)
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { text: text.slice(0, 200) },
      "Could not find a JSON verdict in the judge response.",
    );
  let obj: unknown;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    throw new UpstreamError("UPSTREAM_ERROR", { text: m[0].slice(0, 200) }, "Failed to parse the judge verdict JSON.");
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.score !== "number" || typeof o.reason !== "string")
    throw new UpstreamError("UPSTREAM_ERROR", {}, "The judge verdict format is invalid (score/reason).");
  const score = Math.max(0, Math.min(1, o.score));
  const pass = typeof o.pass === "boolean" ? o.pass : score >= 0.5;
  return { pass, score, reason: o.reason };
}

// model judge — takes a JudgeCompletion (model call) and returns a Judge. Transport is injected via anthropicComplete etc.
export function modelJudge(complete: JudgeCompletion): Judge {
  return {
    async judge(input) {
      const text = await complete(buildPrompt(input), input.screenshot);
      return parseVerdict(text);
    },
  };
}

// Anthropic Messages API transport (fetch). External failures are remapped to UpstreamError (so monitoring blames us).
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
    // With an image, multimodal content (text + base64 image block) — Anthropic Messages vision format.
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
        `judge model call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `judge model ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = json.content?.[0]?.text;
    if (typeof text !== "string")
      throw new UpstreamError("UPSTREAM_ERROR", {}, "The judge model response has no text.");
    return text;
  };
}

// OpenAI Chat Completions transport (fetch). For OpenAI-compatible endpoints, also supports LiteLLM proxies etc. via baseUrl.
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
    // With an image, multimodal content (text + data-URL image_url) — OpenAI-compatible vision format (incl. LiteLLM proxies).
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
        `judge model call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `judge model ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string")
      throw new UpstreamError("UPSTREAM_ERROR", {}, "The judge model response has no text.");
    return text;
  };
}

// Gathers the agent's output text from the trace (assistant messages first, else all messages). For extracting the harness judge's verdict.
export function traceToText(trace: TraceEvent[]): string {
  const messages = trace.filter((e): e is Extract<TraceEvent, { kind: "message" }> => e.kind === "message");
  const assistant = messages.filter((m) => m.role === "assistant");
  return (assistant.length > 0 ? assistant : messages).map((m) => m.text).join("\n");
}

// harness judge transport — dispatches a reference harness (agent) with the judging prompt and takes its trace's output text as the verdict.
// Unified into the same modelJudge(transport) structure as the model judge — only the transport becomes "agent dispatch".
export function harnessComplete(cfg: { dispatch: (task: string) => Promise<TraceEvent[]> }): JudgeCompletion {
  return async (prompt) => traceToText(await cfg.dispatch(prompt));
}
