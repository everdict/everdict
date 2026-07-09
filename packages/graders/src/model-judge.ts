import { type JudgeCriterion, type TraceEvent, UpstreamError } from "@everdict/core";
import type { CriterionVerdict, Judge, JudgeImage, JudgeVerdict } from "./judge.js";

// Model-call primitive — (prompt[, image]) → raw text. Separates transport from judging logic (injected in tests).
// If an image is given, sends multimodally to a vision model (VLM) (e.g. os-use screenshot judging).
export type JudgeCompletion = (prompt: string, image?: JudgeImage) => Promise<string>;

const MAX_CHARS = 6000; // Trace/DOM can be large, so truncate to protect the context.

interface JudgeInput {
  task: string;
  trace?: TraceEvent[];
  dom?: string;
  screenshot?: JudgeImage;
  response?: string; // result-channel final response (prompt snapshot output)
  rubric?: string;
  criteria?: JudgeCriterion[]; // multi-criteria: the verdict must score every listed criterion
  promptTemplate?: string; // custom prompt (must carry {verdict_instruction}); absent → the default template
}

// Agent final answer = the text of the last assistant message in the trace. The final answer is usually at the very end of the trace array,
// so truncating with JSON.stringify(trace).slice(0, MAX) cuts it off → the judge misjudges it as "no final answer". Extract it into a dedicated section.
function finalAnswerOf(trace: TraceEvent[] | undefined): string | undefined {
  if (!trace) return undefined;
  const messages = trace.filter((e): e is Extract<TraceEvent, { kind: "message" }> => e.kind === "message");
  const assistant = messages.filter((m) => m.role === "assistant");
  return assistant[assistant.length - 1]?.text;
}

// The JSON verdict instruction — single verdict, or the multi-criteria shape scoring every listed criterion.
// Expanded into custom templates via the {verdict_instruction} placeholder (the parser relies on this shape).
function verdictInstruction(criteria?: JudgeCriterion[]): string {
  if (!criteria?.length)
    return 'Respond with ONLY a JSON object, no prose: {"pass": boolean, "score": number in [0,1], "reason": string}.';
  const shape = criteria
    .map((c) => `"${c.id}": {"score": number in [0,1], "pass": boolean, "reason": string}`)
    .join(", ");
  return `Respond with ONLY a JSON object, no prose, scoring EVERY listed criterion: {"criteria": {${shape}}, "pass": boolean, "score": number in [0,1], "reason": string} — top-level "pass"/"score" are the overall verdict.`;
}

// The criteria bullet list — a section in the default template, the {criteria} placeholder in custom templates.
function criteriaText(criteria?: JudgeCriterion[]): string {
  if (!criteria?.length) return "";
  return criteria.map((c) => `- ${c.id}${c.weight !== 1 ? ` (weight ${c.weight})` : ""}: ${c.description}`).join("\n");
}

// Custom template rendering — placeholders expand to the RAW evidence values ("" when absent); the template owns all
// framing/section labels. {verdict_instruction} is mandatory (enforced at registration by JudgeSpecSchema).
function renderTemplate(template: string, input: JudgeInput): string {
  const finalAnswer = finalAnswerOf(input.trace) ?? "";
  const values: Record<string, string> = {
    task: input.task,
    rubric: input.rubric ?? "",
    criteria: criteriaText(input.criteria),
    dom: input.dom ? input.dom.slice(0, MAX_CHARS) : "",
    final_answer: finalAnswer.slice(0, MAX_CHARS),
    response: input.response ? input.response.slice(0, MAX_CHARS) : "",
    trace: input.trace ? JSON.stringify(input.trace).slice(0, MAX_CHARS) : "",
    verdict_instruction: verdictInstruction(input.criteria),
  };
  return template.replace(
    /\{(task|rubric|criteria|dom|final_answer|response|trace|verdict_instruction)\}/g,
    (_, key: string) => values[key] ?? "",
  );
}

// Judging prompt — asks the LLM/VLM for a JSON verdict from task + rubric/criteria + (final answer/response/trace/DOM/screenshot).
// A custom promptTemplate replaces the default framing entirely; without one the default template below is used.
function buildPrompt(input: JudgeInput): string {
  if (input.promptTemplate) return renderTemplate(input.promptTemplate, input);
  // The final answer is always fully included in a dedicated section regardless of trace JSON truncation (sliced with its own cap) — avoids misjudgment from truncation.
  const finalAnswer = finalAnswerOf(input.trace);
  // The result-channel response is separate evidence from the trace's final answer — skip it only when identical (avoid duplication).
  const response = input.response && input.response !== finalAnswer ? input.response : undefined;
  const criteria = criteriaText(input.criteria);
  const trace = input.trace ? JSON.stringify(input.trace).slice(0, MAX_CHARS) : "(none)";
  return [
    "You are a strict evaluation judge for an AI agent's run. Judge ONLY from the evidence below.",
    `TASK:\n${input.task}`,
    input.rubric ? `RUBRIC:\n${input.rubric}` : "",
    criteria ? `CRITERIA (score each):\n${criteria}` : "",
    input.dom ? `FINAL DOM (truncated):\n${input.dom.slice(0, MAX_CHARS)}` : "",
    input.screenshot
      ? "A SCREENSHOT of the final UI/desktop state is attached. Judge whether it shows the task's goal state."
      : "",
    finalAnswer ? `AGENT FINAL ANSWER:\n${finalAnswer.slice(0, MAX_CHARS)}` : "",
    response ? `AGENT FINAL RESPONSE (result channel):\n${response.slice(0, MAX_CHARS)}` : "",
    // Since the trace JSON may be truncated, tell it to look at the section above even if the final answer is cut off.
    `EXECUTION TRACE (JSON, truncated${finalAnswer ? "; see AGENT FINAL ANSWER above" : ""}):\n${trace}`,
    verdictInstruction(input.criteria),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Extracts the JSON verdict from the model response (surrounding prose allowed). Format errors → UpstreamError (blame the external dependency).
// With criteria, every declared criterion must be scored — a missing one is a format-contract violation (explicit, never a silent 0).
function parseVerdict(text: string, criteria?: JudgeCriterion[]): JudgeVerdict {
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
  if (!criteria?.length) {
    if (typeof o.score !== "number" || typeof o.reason !== "string")
      throw new UpstreamError("UPSTREAM_ERROR", {}, "The judge verdict format is invalid (score/reason).");
    const score = Math.max(0, Math.min(1, o.score));
    const pass = typeof o.pass === "boolean" ? o.pass : score >= 0.5;
    return { pass, score, reason: o.reason };
  }

  const raw = (o.criteria ?? {}) as Record<string, unknown>;
  const perCriterion: Record<string, CriterionVerdict> = {};
  let weighted = 0;
  let weightSum = 0;
  for (const c of criteria) {
    const entry = raw[c.id] as Record<string, unknown> | undefined;
    if (!entry || typeof entry.score !== "number")
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { criterion: c.id },
        `The judge verdict is missing criterion "${c.id}".`,
      );
    const score = Math.max(0, Math.min(1, entry.score));
    const pass =
      c.passThreshold != null ? score >= c.passThreshold : typeof entry.pass === "boolean" ? entry.pass : score >= 0.5;
    perCriterion[c.id] = { pass, score, reason: typeof entry.reason === "string" ? entry.reason : "" };
    weighted += c.weight * score;
    weightSum += c.weight;
  }
  // Overall: the model's verdict when given; else derived — weighted mean of the criteria scores.
  const overallScore = typeof o.score === "number" ? Math.max(0, Math.min(1, o.score)) : weighted / weightSum;
  const overallPass = typeof o.pass === "boolean" ? o.pass : overallScore >= 0.5;
  const overallReason = typeof o.reason === "string" ? o.reason : "weighted mean of the criteria scores";
  return { pass: overallPass, score: overallScore, reason: overallReason, criteria: perCriterion };
}

// model judge — takes a JudgeCompletion (model call) and returns a Judge. Transport is injected via anthropicComplete etc.
export function modelJudge(complete: JudgeCompletion): Judge {
  return {
    async judge(input) {
      const text = await complete(buildPrompt(input), input.screenshot);
      return parseVerdict(text, input.criteria);
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
