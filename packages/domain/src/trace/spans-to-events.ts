import {
  EVERDICT_ATTR,
  GEN_AI,
  GEN_AI_OPERATION,
  OTEL_ATTR,
  type SpanAttrMapping,
  TRACE_PLANE,
  type TraceEvent,
  type TraceSpan,
} from "@everdict/contracts";

// The PROJECTION: the record (spans) → what graders and judges read (events).
//
// This is the whole reason making spans the record costs nothing downstream. Scoring reads a handful of
// `kind === "tool_call"`-shaped filters; it never needed to know that the thing underneath grew a tree, a
// status and a resource. So the union stays exactly as it was and this function is where the two meet.
//
// It is VERSIONED on purpose (`SPANS_TO_EVENTS_VERSION`). Spans are immutable once ended, but a projection
// is code, and a verdict nobody can re-derive is a verdict nobody can defend. A scorecard records the
// version it judged under instead of a second copy of the bytes.
//
// See docs/architecture/otel-trace-model.md.

// Bump when a change to this file could produce different events for the same spans. Read by the scoring
// path and stamped on the record — never inferred from the package version, which moves for other reasons.
export const SPANS_TO_EVENTS_VERSION = 1;

// The attribute dialects a span can arrive in. Ours is the GenAI convention (semconv.ts); the rest are the
// conventions the platforms that push to our door actually emit — OpenInference (Phoenix/Arize), MLflow
// native, Traceloop/OpenLLMetry. A user-authored `SpanAttrMapping` is tried BEFORE all of them.
export const DEFAULT_SPAN_ATTR_KEYS = {
  model: [GEN_AI.requestModel, GEN_AI.responseModel, "mlflow.llm.model", "llm.model_name"],
  inputTokens: [GEN_AI.inputTokens, "llm.token_count.prompt"],
  outputTokens: [GEN_AI.outputTokens, "llm.token_count.completion"],
  costUsd: [EVERDICT_ATTR.costUsd, "gen_ai.usage.cost"],
  toolName: [GEN_AI.toolName, "tool.name"],
  toolCallId: [GEN_AI.toolCallId, "tool.call_id"],
  toolArgs: ["tool.arguments", GEN_AI.inputMessages, EVERDICT_ATTR.input],
  toolResult: ["tool.result", GEN_AI.outputMessages, EVERDICT_ATTR.output],
  messageText: [GEN_AI.outputMessages, EVERDICT_ATTR.output, "message.content", "output.value"],
} as const;

// A span whose platform DECLARES it a tool, with no tool.* attribute to prove it. Without this branch such
// spans demote to a structural `span` and a judge sees no tool actions at all for that harness.
const SPAN_KIND_KEYS = ["mlflow.spanType", "openinference.span.kind", "span.kind", "traceloop.span.kind"] as const;
const IO_INPUT_KEYS = ["mlflow.spanInputs", "input.value", "gen_ai.prompt", "llm.input_messages", "input"] as const;
const IO_OUTPUT_KEYS = [
  "mlflow.spanOutputs",
  "output.value",
  "gen_ai.completion",
  "llm.output_messages",
  "output",
] as const;
const ARTIFACT_KEYS = {
  ref: ["artifact.ref", "artifact.uri", "mlflow.artifact.uri"],
  name: ["artifact.name"],
  mediaType: ["artifact.media_type", "artifact.mediaType"],
  role: ["artifact.role"],
} as const;

type Attrs = Record<string, unknown>;

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function pickStr(a: Attrs, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = str(a[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}
function pickNum(a: Attrs, keys: readonly string[]): number | undefined {
  for (const k of keys) {
    const v = num(a[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}
function firstDefined(a: Attrs, keys: readonly string[]): unknown {
  for (const k of keys) if (a[k] !== undefined) return a[k];
  return undefined;
}
function asText(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
function msOf(iso: string): number | undefined {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function declaredKindIsTool(a: Attrs): boolean {
  const declared = pickStr(a, SPAN_KIND_KEYS)?.toUpperCase();
  return declared !== undefined && (declared.includes("TOOL") || declared.includes("FUNCTION"));
}

// A span's own bag PLUS its resource bag. A resource attribute describes the process, so it is visible to a
// span-level read (a span-level key of the same name wins) — the same merge the OTLP door has always done,
// kept here rather than performed destructively at ingest so the record still knows which was which.
function readable(span: TraceSpan): Attrs {
  return { ...(span.resource ?? {}), ...span.attributes };
}

export interface SpansToEventsOptions {
  // A per-harness attribute mapping (the wizard-authored overlay). Tried before every default dialect.
  mapping?: SpanAttrMapping;
}

export function spansToEvents(spans: TraceSpan[], opts: SpansToEventsOptions = {}): TraceEvent[] {
  const mapping = opts.mapping;
  const keys = {
    model: [...(mapping?.model ?? []), ...DEFAULT_SPAN_ATTR_KEYS.model],
    inputTokens: [...(mapping?.inputTokens ?? []), ...DEFAULT_SPAN_ATTR_KEYS.inputTokens],
    outputTokens: [...(mapping?.outputTokens ?? []), ...DEFAULT_SPAN_ATTR_KEYS.outputTokens],
    costUsd: [...(mapping?.costUsd ?? []), ...DEFAULT_SPAN_ATTR_KEYS.costUsd],
    toolName: [...(mapping?.toolName ?? []), ...DEFAULT_SPAN_ATTR_KEYS.toolName],
    toolCallId: [...(mapping?.toolCallId ?? []), ...DEFAULT_SPAN_ATTR_KEYS.toolCallId],
    toolArgs: [...(mapping?.toolArgs ?? []), ...DEFAULT_SPAN_ATTR_KEYS.toolArgs],
    toolResult: [...(mapping?.toolResult ?? []), ...DEFAULT_SPAN_ATTR_KEYS.toolResult],
    messageText: [...(mapping?.messageText ?? []), ...DEFAULT_SPAN_ATTR_KEYS.messageText],
  };

  const sorted = [...spans].sort((a, b) => (msOf(a.startedAt) ?? 0) - (msOf(b.startedAt) ?? 0));
  const base = sorted.length > 0 ? (msOf(sorted[0]?.startedAt ?? "") ?? 0) : 0;
  const out: TraceEvent[] = [];

  for (const span of sorted) {
    const startMs = msOf(span.startedAt);
    const endMs = msOf(span.endedAt);
    if (startMs === undefined) continue; // an undatable span cannot be placed; dropping beats inventing
    const a = readable(span);
    const durationMs = endMs !== undefined && endMs > startMs ? endMs - startMs : 0;
    // Every projected event carries the STRUCTURE it came from, so a reader that only has events (an old
    // sealed body, a judge's copy) can still draw the tree the record holds.
    const structure = {
      t: startMs - base,
      at: span.startedAt,
      spanId: span.spanId,
      ...(span.parentSpanId !== undefined ? { parentId: span.parentSpanId } : {}),
      durationMs,
    };

    const operation = str(a[GEN_AI.operationName]);
    const plane = str(a[EVERDICT_ATTR.plane]);
    // MLflow 3.x autolog puts native token/cost in NESTED objects rather than flat attributes, and real
    // traces carry them there even with no gen_ai.* present (live-verified against 3.11). Tried after the
    // mapping and the flat keys, never before.
    const tokenUsage = (a["mlflow.chat.tokenUsage"] ?? {}) as Record<string, unknown>;
    const llmCost = (a["mlflow.llm.cost"] ?? {}) as Record<string, unknown>;
    const model = pickStr(a, keys.model);
    const inTok = pickNum(a, keys.inputTokens) ?? num(tokenUsage.input_tokens);
    const outTok = pickNum(a, keys.outputTokens) ?? num(tokenUsage.output_tokens);
    const toolName = operation === GEN_AI_OPERATION.executeTool ? (pickStr(a, keys.toolName) ?? span.name) : undefined;

    // An artifact reference is its own event regardless of how the span classifies below — a judge's
    // `artifact` requirement has to be satisfiable from any span that produced one.
    const artifactRef = pickStr(a, ARTIFACT_KEYS.ref);
    if (artifactRef !== undefined) {
      const mediaType = pickStr(a, ARTIFACT_KEYS.mediaType);
      const role = pickStr(a, ARTIFACT_KEYS.role);
      out.push({
        t: structure.t,
        at: span.startedAt,
        kind: "artifact",
        name: pickStr(a, ARTIFACT_KEYS.name) ?? span.name,
        ref: artifactRef,
        ...(mediaType ? { mediaType } : {}),
        ...(role ? { role } : {}),
        parentId: span.spanId, // a product OF the span, not the span itself
      });
    }

    if (plane === TRACE_PLANE.placement) {
      // The placement plane projects back to the `infra` kind the union already has, so every reader of
      // infra keeps working while the record underneath is an ordinary span with a real duration.
      out.push({
        ...structure,
        kind: "infra",
        scope: "placement",
        ...(span.name !== "" ? { event: span.name } : {}),
        message: pickStr(a, IO_OUTPUT_KEYS) ?? span.status?.message ?? span.name,
        ...((str(a.k8s_pod_name) ?? str(a["k8s.pod.name"])) ? { unit: asText(a["k8s.pod.name"]) } : {}),
        ...((str(a["k8s.node.name"]) ?? str(a["host.name"]))
          ? { node: asText(a["k8s.node.name"] ?? a["host.name"]) }
          : {}),
      });
    } else if (
      operation === GEN_AI_OPERATION.chat ||
      model !== undefined ||
      inTok !== undefined ||
      outTok !== undefined
    ) {
      out.push({
        ...structure,
        kind: "llm_call",
        model: model ?? "",
        cost: {
          inputTokens: inTok ?? 0,
          outputTokens: outTok ?? 0,
          usd: pickNum(a, keys.costUsd) ?? num(llmCost.total_cost) ?? 0,
        },
        latencyMs: durationMs,
      });
    } else if (toolName !== undefined || pickStr(a, keys.toolName) !== undefined || declaredKindIsTool(a)) {
      const name = toolName ?? pickStr(a, keys.toolName) ?? span.name;
      const id = pickStr(a, keys.toolCallId) ?? span.spanId;
      out.push({
        ...structure,
        kind: "tool_call",
        id,
        name,
        args: firstDefined(a, [...keys.toolArgs, ...IO_INPUT_KEYS]),
      });
      // The result is the call's own outcome — the span IS the call, so the result hangs under it with the
      // span's END as its instant. This is the pair a duration-blind reader used to have to infer.
      out.push({
        t: (endMs ?? startMs) - base,
        at: span.endedAt,
        kind: "tool_result",
        id,
        ok: span.status?.code !== "error",
        output: pickStr(a, keys.toolResult) ?? asText(firstDefined(a, IO_OUTPUT_KEYS)),
        parentId: span.spanId,
      });
    } else if (str(a[EVERDICT_ATTR.envAction]) !== undefined) {
      const detail = a[EVERDICT_ATTR.input];
      out.push({
        ...structure,
        kind: "env_action",
        action: asText(a[EVERDICT_ATTR.envAction]),
        ...(detail === undefined ? {} : { detail }),
      });
    } else {
      const text = pickStr(a, keys.messageText);
      if (text !== undefined) {
        // The speaker round-trips through our own key: the GenAI conventions carry role inside a structured
        // message list, which a single text has no room for. Anything else is the assistant, which is what
        // an external platform's lone output value means.
        const role = str(a[EVERDICT_ATTR.messageRole]) === "user" ? "user" : "assistant";
        out.push({ ...structure, kind: "message", role, text });
      } else if (artifactRef === undefined) {
        out.push({ ...structure, kind: "span", name: span.name, attributes: span.attributes });
      }
    }

    // A span that ended badly says so once, as an error event — the union has no status field, and a judge
    // that never sees the failure scores a broken run as a quiet one.
    if (span.status?.code === "error") {
      out.push({
        t: (endMs ?? startMs) - base,
        at: span.endedAt,
        kind: "error",
        message: span.status.message ?? str(a[OTEL_ATTR.errorType]) ?? `${span.name} failed`,
        parentId: span.spanId,
      });
    }

    // Span EVENTS — the points inside the interval. These had nowhere to live in the old model, which is
    // why an orchestrator's "Driver Failure" either became a top-level instant or vanished.
    for (const event of span.events ?? []) {
      const at = msOf(event.at);
      if (at === undefined) continue;
      const point = { t: at - base, at: event.at, parentId: span.spanId };
      if (plane === TRACE_PLANE.placement) {
        out.push({
          ...point,
          kind: "infra",
          scope: "placement",
          event: event.name,
          message: asText(event.attributes?.message ?? event.name),
        });
      } else if (event.name === "log") {
        // The stream round-trips through our own key — OTel names no such thing, and stderr-vs-stdout is
        // the difference between "the agent talked" and "the agent complained".
        const stream = str(event.attributes?.[EVERDICT_ATTR.logStream]) === "stderr" ? "stderr" : "stdout";
        out.push({ ...point, kind: "log", stream, text: asText(event.attributes?.message ?? "") });
      } else {
        out.push({ ...point, kind: "log", stream: "stdout", text: `${event.name}${eventDetail(event.attributes)}` });
      }
    }
  }

  // One stream, in the order things happened — the same ordering guarantee the flat model gave for free.
  return out.sort((x, y) => x.t - y.t);
}

function eventDetail(attributes: Attrs | undefined): string {
  if (!attributes || Object.keys(attributes).length === 0) return "";
  return `: ${asText(attributes)}`;
}
