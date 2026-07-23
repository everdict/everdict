import type {
  EvidenceSelector,
  EvidenceSlot,
  SpanAttrMapping,
  SpanAttrSample,
  TraceEvent,
  TraceEvidence,
  TraceProvenance,
  TraceSpanNode,
  TraceSummary,
} from "@everdict/contracts";

// The shared intermediate-representation span for OTel/MLflow.
export interface Span {
  name: string;
  startMs: number;
  endMs: number;
  attrs: Record<string, unknown>;
  spanId?: string; // platform span id (drives the waterfall node id + parentage) — absent = fall back to a name-index id
  parentId?: string; // parent span id (waterfall nesting) — absent = a root / the platform doesn't expose parentage
}

// Span[] → the raw-attribute samples inspect() surfaces so a SpanAttrMapping can be authored against real keys.
export function spansToRawAttributes(spans: Span[]): SpanAttrSample[] {
  return spans.map((s) => ({ spanName: s.name, attrs: s.attrs }));
}

// The Everdict origin keys, across the per-platform naming variants a pulled trace can carry: MLflow trace_metadata
// uses camelCase (everdict.scorecardId); OTLP/OTel/Phoenix span attributes use snake (everdict.scorecard_id); Langfuse
// metadata is UNPREFIXED (scorecardId); the harness writes everdict.run_id for correlation. First defined wins.
const PROVENANCE_KEYS = {
  runId: ["everdict.run_id", "everdict.runId", "runId"],
  scorecardId: ["everdict.scorecardId", "everdict.scorecard_id", "scorecardId"],
  dataset: ["everdict.dataset", "dataset"],
  harness: ["everdict.harness", "harness"],
  caseId: ["everdict.caseId", "everdict.case_id", "caseId"],
} as const;
const ALL_PROVENANCE_KEYS: readonly string[] = Object.values(PROVENANCE_KEYS).flat();

// Extract Everdict provenance from a bag of platform metadata/tags/attributes (string-valued keys, variant-tolerant).
// Returns undefined when the trace carries NONE (an unrelated external trace) — never a partial object of empty strings.
export function extractProvenance(bag: Record<string, unknown>): TraceProvenance | undefined {
  const pick = (keys: readonly string[]): string | undefined => {
    for (const k of keys) {
      const v = bag[k];
      if (typeof v === "string" && v.trim() !== "") return v;
    }
    return undefined;
  };
  const runId = pick(PROVENANCE_KEYS.runId);
  const scorecardId = pick(PROVENANCE_KEYS.scorecardId);
  const dataset = pick(PROVENANCE_KEYS.dataset);
  const harness = pick(PROVENANCE_KEYS.harness);
  const caseId = pick(PROVENANCE_KEYS.caseId);
  if (!runId && !scorecardId && !dataset && !harness && !caseId) return undefined;
  return {
    ...(runId ? { runId } : {}),
    ...(scorecardId ? { scorecardId } : {}),
    ...(dataset ? { dataset } : {}),
    ...(harness ? { harness } : {}),
    ...(caseId ? { caseId } : {}),
  };
}

// Scan a Span[] for the Everdict provenance attributes (the sink writes them on the root/CHAIN span, the harness on
// resource attrs) — merge the specific keys across spans (first defined wins), then extract. Powers otel/mlflow.
export function provenanceFromSpans(spans: Span[]): TraceProvenance | undefined {
  return provenanceByLookup((k) => {
    for (const s of spans) if (s.attrs[k] !== undefined) return s.attrs[k];
    return undefined;
  });
}

// Extract provenance when the attributes are only addressable via an accessor (e.g. Phoenix's mixed nested/flat
// attrs, or LangSmith's inputs+extra.metadata split) — `lookup(variantKey)` returns the value or undefined.
export function provenanceByLookup(lookup: (key: string) => unknown): TraceProvenance | undefined {
  const bag: Record<string, unknown> = {};
  for (const k of ALL_PROVENANCE_KEYS) {
    const v = lookup(k);
    if (v !== undefined) bag[k] = v;
  }
  return extractProvenance(bag);
}

// Span[] → the metric fields of a TraceSummary (id/scope/status/tags are added by the per-source caller).
// Pure: derives name/time/duration from the spans and tokens/cost/model from the normalized llm_call events.
export function summarizeSpans(spans: Span[]): Omit<TraceSummary, "id"> {
  if (spans.length === 0) return {};
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const startMs = sorted[0]?.startMs ?? 0;
  const endMs = spans.reduce((m, s) => Math.max(m, s.endMs), startMs);
  const events = spansToTraceEvents(spans);
  let input = 0;
  let output = 0;
  let usd = 0;
  let model: string | undefined;
  let hasLlm = false;
  for (const e of events) {
    if (e.kind !== "llm_call") continue;
    hasLlm = true;
    if (model === undefined && e.model) model = e.model;
    if (e.cost) {
      input += e.cost.inputTokens;
      output += e.cost.outputTokens;
      usd += e.cost.usd;
    }
  }
  const name = sorted[0]?.name;
  const provenance = provenanceFromSpans(spans);
  return {
    ...(name ? { name } : {}),
    ...(startMs > 0 ? { startedAt: new Date(startMs).toISOString() } : {}),
    durationMs: Math.max(0, endMs - startMs),
    spanCount: spans.length,
    ...(hasLlm ? { tokens: { input, output }, costUsd: usd } : {}),
    ...(model ? { llmModel: model } : {}),
    ...(provenance ? { provenance } : {}),
  };
}

// The first model an llm_call span reports, mapping-aware — enriches list rows on platforms whose trace-level
// list payload omits the model (MLflow TraceInfo carries tokens/cost but never a model; live-verified 3.11/3.14).
export function modelFromSpans(spans: Span[], mapping?: SpanAttrMapping): string | undefined {
  for (const e of spansToTraceEvents(spans, mapping)) {
    if (e.kind === "llm_call" && e.model !== "") return e.model;
  }
  return undefined;
}

// Span-kind attribute keys per platform (MLflow `mlflow.spanType`: LLM/CHAT_MODEL/TOOL/AGENT/CHAIN/RETRIEVER/… ·
// OpenInference/Phoenix `openinference.span.kind` · a generic `span.kind`). Classifies a span into a waterfall type.
const SPAN_KIND_KEYS = ["mlflow.spanType", "openinference.span.kind", "span.kind", "traceloop.span.kind"] as const;
// I/O channels a platform records on a span (best-effort — first defined wins; objects are stringified).
const IO_INPUT_KEYS = ["mlflow.spanInputs", "input.value", "gen_ai.prompt", "llm.input_messages", "input"] as const;
const IO_OUTPUT_KEYS = [
  "mlflow.spanOutputs",
  "output.value",
  "gen_ai.completion",
  "llm.output_messages",
  "output",
] as const;

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// The built-in OTel GenAI + MLflow-native default attribute keys per TraceEvent field. A harness that emits these
// needs no mapping; a harness that doesn't supplies a SpanAttrMapping whose keys are tried FIRST (see spansToTraceEvents).
const DEFAULT_KEYS = {
  model: ["gen_ai.request.model", "gen_ai.response.model", "mlflow.llm.model"],
  inputTokens: ["gen_ai.usage.input_tokens"],
  outputTokens: ["gen_ai.usage.output_tokens"],
  costUsd: ["gen_ai.usage.cost"],
  toolName: ["tool.name", "gen_ai.tool.name"],
  toolCallId: ["tool.call_id"],
  toolArgs: ["tool.arguments"],
  toolResult: ["tool.result"],
  messageText: ["message.content", "output.value"],
} as const;

// Conventional attribute keys for the artifact channel (fixed, not part of the per-field SpanAttrMapping override).
const ARTIFACT_KEYS = {
  ref: ["artifact.ref", "artifact.uri", "mlflow.artifact.uri"],
  name: ["artifact.name"],
  mediaType: ["artifact.media_type", "artifact.mediaType"],
  role: ["artifact.role"],
} as const;

// First defined string among a field's mapping-override keys then its defaults.
function pickStr(a: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = str(a[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}
function pickNum(a: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const k of keys) {
    const v = num(a[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}
function firstDefined(a: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) if (a[k] !== undefined) return a[k];
  return undefined;
}

// Span → TraceEvent. Defaults to the OTel GenAI semantic conventions; a per-harness SpanAttrMapping overrides the
// attribute keys (tried first, then the defaults) so a harness with non-standard instrumentation still normalizes.
export function spansToTraceEvents(spans: Span[], mapping?: SpanAttrMapping): TraceEvent[] {
  const keys = {
    model: [...(mapping?.model ?? []), ...DEFAULT_KEYS.model],
    inputTokens: [...(mapping?.inputTokens ?? []), ...DEFAULT_KEYS.inputTokens],
    outputTokens: [...(mapping?.outputTokens ?? []), ...DEFAULT_KEYS.outputTokens],
    costUsd: [...(mapping?.costUsd ?? []), ...DEFAULT_KEYS.costUsd],
    toolName: [...(mapping?.toolName ?? []), ...DEFAULT_KEYS.toolName],
    toolCallId: [...(mapping?.toolCallId ?? []), ...DEFAULT_KEYS.toolCallId],
    toolArgs: [...(mapping?.toolArgs ?? []), ...DEFAULT_KEYS.toolArgs],
    toolResult: [...(mapping?.toolResult ?? []), ...DEFAULT_KEYS.toolResult],
    messageText: [...(mapping?.messageText ?? []), ...DEFAULT_KEYS.messageText],
  };
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const base = sorted[0]?.startMs ?? 0;
  const out: TraceEvent[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (!s) continue;
    const t = s.startMs - base;
    const a = s.attrs;
    // MLflow 3.x native token/cost live in nested objects (mlflow.chat.tokenUsage/mlflow.llm.cost) — kept as a fallback
    // after the mapping+GenAI keys, since real MLflow 3.11 autolog traces carry them there even without gen_ai.* (live-verified).
    const tu = (a["mlflow.chat.tokenUsage"] ?? {}) as Record<string, unknown>;
    const llmCost = (a["mlflow.llm.cost"] ?? {}) as Record<string, unknown>;
    const model = pickStr(a, keys.model);
    const inTok = pickNum(a, keys.inputTokens) ?? num(tu.input_tokens);
    const outTok = pickNum(a, keys.outputTokens) ?? num(tu.output_tokens);
    const toolName = pickStr(a, keys.toolName);

    // Artifact channel — a span that references a produced artifact surfaces it as its own event (a fetchable ref,
    // not the bytes), regardless of how the span classifies below. Conventional keys (artifact.* / mlflow.artifact.uri).
    const artifactRef = pickStr(a, ARTIFACT_KEYS.ref);
    if (artifactRef !== undefined) {
      const mediaType = pickStr(a, ARTIFACT_KEYS.mediaType);
      const role = pickStr(a, ARTIFACT_KEYS.role);
      out.push({
        t,
        kind: "artifact",
        name: pickStr(a, ARTIFACT_KEYS.name) ?? s.name,
        ref: artifactRef,
        ...(mediaType ? { mediaType } : {}),
        ...(role ? { role } : {}),
      });
    }

    if (model !== undefined || inTok !== undefined || outTok !== undefined) {
      out.push({
        t,
        kind: "llm_call",
        model: model ?? "",
        cost: {
          inputTokens: inTok ?? 0,
          outputTokens: outTok ?? 0,
          usd: pickNum(a, keys.costUsd) ?? num(llmCost.total_cost) ?? 0,
        },
        latencyMs: s.endMs - s.startMs,
      });
    } else if (toolName !== undefined) {
      const id = pickStr(a, keys.toolCallId) ?? `${s.name}-${i}`;
      out.push({ t, kind: "tool_call", id, name: toolName, args: firstDefined(a, keys.toolArgs) });
      const ok = a["tool.error"] === undefined && a.error === undefined;
      out.push({ t: s.endMs - base, kind: "tool_result", id, ok, output: pickStr(a, keys.toolResult) ?? "" });
    } else {
      const text = pickStr(a, keys.messageText);
      if (text !== undefined) out.push({ t, kind: "message", role: "assistant", text });
      // Structural span (chain/agent/retriever etc.) — preserved instead of dropped, so a `span` judge requirement is
      // satisfiable and non-LLM steps aren't silently lost. Skip a bare artifact-only span (already emitted above).
      else if (artifactRef === undefined) out.push({ t, kind: "span", name: s.name, attributes: a });
    }
  }
  return out;
}

// --- Evidence slots (finalAnswer / dom / screenshot) — judge evidence extracted from the trace itself. ---

// A screenshot attribute value classified: inline bytes (data-URI or bare base64) vs a fetchable reference.
export type ScreenshotValue = { base64: string; mediaType: string } | { ref: string };

const DATA_URI_RE = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;
// Bare-base64 heuristic: long enough to be an image and made only of base64 characters (browser-use style inline PNGs).
const BARE_BASE64_RE = /^[A-Za-z0-9+/=\r\n]+$/;

export function classifyScreenshotValue(v: string): ScreenshotValue {
  const m = v.match(DATA_URI_RE);
  if (m?.[1] && m[2]) return { base64: m[2].replace(/\s/g, ""), mediaType: m[1] };
  if (v.length >= 256 && BARE_BASE64_RE.test(v)) return { base64: v.replace(/\s/g, ""), mediaType: "image/png" };
  return { ref: v };
}

// "a.b[0].c" → path segments. Deliberately-simple dot/bracket syntax, NOT full JSONPath.
function pathSegments(path: string): (string | number)[] | undefined {
  const out: (string | number)[] = [];
  for (const part of path.split(".")) {
    const m = part.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) return undefined;
    if (m[1]) out.push(m[1]);
    for (const idx of m[2]?.match(/\d+/g) ?? []) out.push(Number(idx));
  }
  return out.length > 0 ? out : undefined;
}

// Parse a JSON-looking string into its value (else keep the string) — attr values are often JSON strings.
function maybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

// Walk a dot/bracket path INTO an attr value (an object, or a JSON string — parsed transparently at each hop).
export function resolveValuePath(value: unknown, path: string): unknown {
  const segments = pathSegments(path);
  if (!segments) return undefined;
  let current = maybeJson(value);
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (typeof seg !== "number") return undefined;
      current = maybeJson(current[seg]);
    } else if (typeof current === "object") {
      current = maybeJson((current as Record<string | number, unknown>)[seg]);
    } else {
      return undefined;
    }
  }
  return current;
}

// A resolved evidence value as prompt text — strings pass through, scalars stringify, objects JSON-stringify.
function evidenceText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Resolve ONE slot: selector-major — the first selector (in slot order) that yields a value wins; within a
// selector, `pick` decides which span's occurrence wins (default "last" = the final state).
function resolveSlot(sorted: Span[], slot: EvidenceSlot | undefined): string | undefined {
  for (const entry of slot ?? []) {
    const sel: EvidenceSelector = typeof entry === "string" ? { key: entry } : entry;
    const spans = sel.pick === "first" ? sorted : [...sorted].reverse();
    for (const s of spans) {
      const raw = s.attrs[sel.key];
      if (raw === undefined) continue;
      const value = sel.path === undefined ? raw : resolveValuePath(raw, sel.path);
      const text = evidenceText(value);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

// Span[] + the mapping's evidence slots → TraceEvidence. Fixed slots (finalAnswer/dom/screenshot) plus the
// free-form custom `evidence` record (name → the judge's {<name>} placeholder). Explicit-mapping only — no
// built-in default keys, so nothing is guessed. Pure: an unresolvable screenshot stays a ref and URL values stay
// URLs; byte/text resolution is I/O and belongs to the source (extractEvidence).
export function spansToEvidence(spans: Span[], mapping?: SpanAttrMapping): TraceEvidence | undefined {
  const customSlots = Object.entries(mapping?.evidence ?? {});
  const hasAny =
    (mapping?.finalAnswer?.length ?? 0) > 0 ||
    (mapping?.dom?.length ?? 0) > 0 ||
    (mapping?.screenshot?.length ?? 0) > 0 ||
    customSlots.some(([, slot]) => slot.length > 0);
  if (!hasAny) return undefined;
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const finalAnswer = resolveSlot(sorted, mapping?.finalAnswer);
  const dom = resolveSlot(sorted, mapping?.dom);
  const shot = resolveSlot(sorted, mapping?.screenshot);
  const custom: Record<string, string> = {};
  for (const [name, slot] of customSlots) {
    const value = resolveSlot(sorted, slot);
    if (value !== undefined) custom[name] = value;
  }
  const hasCustom = Object.keys(custom).length > 0;
  if (finalAnswer === undefined && dom === undefined && shot === undefined && !hasCustom) return undefined;
  const screenshot = shot !== undefined ? classifyScreenshotValue(shot) : undefined;
  return {
    ...(finalAnswer !== undefined ? { finalAnswer } : {}),
    ...(dom !== undefined ? { dom } : {}),
    ...(screenshot && "base64" in screenshot
      ? { screenshot: screenshot.base64, screenshotMediaType: screenshot.mediaType }
      : {}),
    ...(screenshot && "ref" in screenshot ? { screenshotRef: screenshot.ref } : {}),
    ...(hasCustom ? { custom } : {}),
  };
}

// Append the extracted final answer as the trace's final assistant message (unless the timeline already ends with
// the same text) — so hasFinalAnswer / the {final_answer} prompt section / trace display all see it with no new channel.
export function withEvidenceEvents(events: TraceEvent[], evidence?: TraceEvidence): TraceEvent[] {
  const answer = evidence?.finalAnswer;
  if (!answer) return events;
  const assistant = events.filter(
    (e): e is Extract<TraceEvent, { kind: "message" }> => e.kind === "message" && e.role === "assistant",
  );
  if (assistant[assistant.length - 1]?.text === answer) return events;
  const t = events.reduce((m, e) => Math.max(m, e.t), 0);
  return [...events, { t, kind: "message", role: "assistant", text: answer }];
}

// First defined I/O value as a display string (an object/array is JSON-stringified; a string passes through).
function pickIo(a: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = a[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return undefined;
}

// Classify a span into a waterfall type — the platform's declared span kind first, then infer from GenAI attrs.
function classifySpan(
  a: Record<string, unknown>,
  model: string | undefined,
  toolName: string | undefined,
): TraceSpanNode["type"] {
  const declared = pickStr(a, SPAN_KIND_KEYS)?.toUpperCase();
  if (declared) {
    if (declared.includes("AGENT")) return "agent";
    if (declared.includes("TOOL") || declared.includes("FUNCTION")) return "tool";
    if (declared.includes("RETRIEV")) return "retriever";
    if (declared.includes("LLM") || declared.includes("CHAT") || declared.includes("COMPLETION")) return "llm";
    if (declared.includes("CHAIN")) return "chain";
  }
  if (model !== undefined) return "llm";
  if (toolName !== undefined) return "tool";
  return "span";
}

// Span[] → the structured waterfall nodes the observability-grade detail dialog renders. Reuses the same attribute-key
// resolution as spansToTraceEvents (mapping override then GenAI/MLflow defaults) for model/tokens/cost, and captures
// the span's declared kind + I/O. Offsets are relative to the trace's earliest span. Pure/deterministic.
export function spansToSpanNodes(spans: Span[], mapping?: SpanAttrMapping): TraceSpanNode[] {
  if (spans.length === 0) return [];
  const modelKeys = [...(mapping?.model ?? []), ...DEFAULT_KEYS.model];
  const inKeys = [...(mapping?.inputTokens ?? []), ...DEFAULT_KEYS.inputTokens];
  const outKeys = [...(mapping?.outputTokens ?? []), ...DEFAULT_KEYS.outputTokens];
  const costKeys = [...(mapping?.costUsd ?? []), ...DEFAULT_KEYS.costUsd];
  const toolKeys = [...(mapping?.toolName ?? []), ...DEFAULT_KEYS.toolName];
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const base = sorted[0]?.startMs ?? 0;
  return sorted.map((s, i) => {
    const a = s.attrs;
    const tu = (a["mlflow.chat.tokenUsage"] ?? {}) as Record<string, unknown>;
    const llmCost = (a["mlflow.llm.cost"] ?? {}) as Record<string, unknown>;
    const model = pickStr(a, modelKeys);
    const inTok = pickNum(a, inKeys) ?? num(tu.input_tokens);
    const outTok = pickNum(a, outKeys) ?? num(tu.output_tokens);
    const usd = pickNum(a, costKeys) ?? num(llmCost.total_cost);
    const input = pickIo(a, IO_INPUT_KEYS);
    const output = pickIo(a, IO_OUTPUT_KEYS);
    return {
      id: s.spanId ?? `${s.name}-${i}`,
      ...(s.parentId ? { parentId: s.parentId } : {}),
      name: s.name,
      type: classifySpan(a, model, pickStr(a, toolKeys)),
      startOffsetMs: Math.max(0, s.startMs - base),
      durationMs: Math.max(0, s.endMs - s.startMs),
      attributes: a,
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(inTok !== undefined || outTok !== undefined
        ? {
            tokens: {
              ...(inTok !== undefined ? { input: inTok } : {}),
              ...(outTok !== undefined ? { output: outTok } : {}),
            },
          }
        : {}),
      ...(usd !== undefined ? { costUsd: usd } : {}),
    };
  });
}
