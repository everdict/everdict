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
import { isReservedObservationAction } from "../observation/observation-trace.js";

// The model a pulled span did not name — a VISIBLE bucket on every model axis (usage, observed models),
// never an empty string that renders as nothing. Billing attribution already treats an unattributable call
// conservatively (own-pays: not billed to the workspace); this only makes the unknown spend readable.
export const UNKNOWN_MODEL = "unknown";

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
// v2: an `invoke_agent` span projects as a structural span (+ its recorded input as a user message) instead
// of an llm_call, and a chat span's captured output text projects as an assistant message — the recorder's
// evidence used to vanish into an llm_call that has no room for text.
export const SPANS_TO_EVENTS_VERSION = 2;

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

// ── THE TWO FACTS THIS PROJECTION READS OFF THE WHOLE BATCH ──────────────────────────────────────────
//
// `spansToEvents` is not a per-span map. Two of its answers are properties of the ARRAY it was handed, and
// both change when the array is a slice of the plane rather than the plane:
//
//   baseMs         the earliest startedAt — every projected event's relative `t` is measured from it
//   perCallTokens  whether ANY chat span carries token counts — decides whether an `invoke_agent`
//                  aggregate projects as an llm_call or is suppressed as a double-count
//
// So a paged reader that projects each page independently produces different `t` values and, for a plane
// with an aggregate span, a different NUMBER of llm_call events than a reader that projects the plane whole.
// The same sealed evidence would read two ways depending on page size, and a judge and a cost fold would
// disagree because of pagination.
//
// Making them an explicit, computable value is the repair: the trajectory store derives them ONCE at seal —
// where the whole plane is legitimately in hand — records them as the plane's provenance, and passes them
// back in on every page. Absent, they are derived from whatever batch is here, which is exactly the old
// behaviour and the right one for a caller that genuinely holds the whole plane.
// See docs/architecture/long-horizon-trace-reads.md.
export interface SpanBatchFacts {
  baseMs: number;
  perCallTokens: boolean;
}

// The order this projection reads spans in. Exported because the trajectory store has to STORE a spans plane
// in exactly this order: it pages by row position, so if the stored order and the projection's order differ,
// page 1 holds spans the whole-plane projection places elsewhere and the concatenated pages come out
// permuted. One comparator, three callers (the projection, the batch facts, the seal) — spelled a second
// time it would already have diverged on the undatable-span case (L3).
export function sortSpansForProjection(spans: readonly TraceSpan[]): TraceSpan[] {
  return [...spans].sort((a, b) => (msOf(a.startedAt) ?? 0) - (msOf(b.startedAt) ?? 0));
}

// The one owner of that derivation, so the seal that records the facts and the projection that consumes them
// cannot compute them differently (rule `protocol` L3 — a predicate written twice has already diverged).
export function spanBatchFacts(spans: readonly TraceSpan[]): SpanBatchFacts {
  const sorted = sortSpansForProjection(spans);
  return {
    baseMs: sorted.length > 0 ? (msOf(sorted[0]?.startedAt ?? "") ?? 0) : 0,
    // Whether any chat span in this batch carries its own token counts. Decides how an `invoke_agent` span's
    // aggregate tokens project: per-call tokens present → the aggregate is a duplicate a cost-summing reader
    // must not see twice; absent (a record sealed before the recorder stamped per-call usage) → the aggregate
    // is the only token evidence there is and still projects as the one llm_call.
    perCallTokens: sorted.some((s) => {
      const sa = readable(s);
      return (
        str(sa[GEN_AI.operationName]) === GEN_AI_OPERATION.chat &&
        (pickNum(sa, DEFAULT_SPAN_ATTR_KEYS.inputTokens) !== undefined ||
          pickNum(sa, DEFAULT_SPAN_ATTR_KEYS.outputTokens) !== undefined)
      );
    }),
  };
}

export interface SpansToEventsOptions {
  // A per-harness attribute mapping (the wizard-authored overlay). Tried before every default dialect.
  mapping?: SpanAttrMapping;
  // The plane's own batch facts, when the caller is projecting a PAGE of a plane rather than a whole one.
  // See `SpanBatchFacts`: without them a page's projection is measured against the page.
  batch?: SpanBatchFacts;
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

  const sorted = sortSpansForProjection(spans);
  // The plane's facts when the caller holds the plane, this page's when it does not and said so. Never
  // silently the page's: see `SpanBatchFacts` for what that costs.
  const { baseMs: base, perCallTokens } = opts.batch ?? spanBatchFacts(sorted);
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
    } else if (operation === GEN_AI_OPERATION.invokeAgent) {
      // The agent root (or a nested subagent): a structural span, so its attribute bag — the aggregate
      // usage, the finish reasons, the semconv stamp — stays readable. Never an llm_call: with per-call
      // tokens on the chat spans beneath it, projecting the aggregate as another llm_call double-counts
      // every reader that sums cost (the `perCallTokens` fallback above covers older records).
      out.push({ ...structure, kind: "span", name: span.name, attributes: span.attributes });
      const inputText = str(a[GEN_AI.inputMessages]) ?? str(a[EVERDICT_ATTR.input]);
      if (inputText !== undefined) {
        // What the turn was asked — the recorder stamps it on the root with the speaker on our round-trip key.
        const role = str(a[EVERDICT_ATTR.messageRole]) === "assistant" ? "assistant" : "user";
        out.push({
          t: structure.t,
          at: span.startedAt,
          kind: "message",
          role,
          text: inputText,
          parentId: span.spanId,
        });
      }
      if (!perCallTokens && (inTok !== undefined || outTok !== undefined)) {
        out.push({
          ...structure,
          kind: "llm_call",
          model: model ?? UNKNOWN_MODEL, // named, so the usage/model axes show "unknown" instead of a silent empty bucket
          cost: {
            inputTokens: inTok ?? 0,
            outputTokens: outTok ?? 0,
            usd: pickNum(a, keys.costUsd) ?? num(llmCost.total_cost) ?? 0,
          },
          latencyMs: durationMs,
        });
      }
    } else if (
      operation === GEN_AI_OPERATION.chat ||
      model !== undefined ||
      inTok !== undefined ||
      outTok !== undefined
    ) {
      out.push({
        ...structure,
        kind: "llm_call",
        model: model ?? UNKNOWN_MODEL, // named, so the usage/model axes show "unknown" instead of a silent empty bucket
        cost: {
          inputTokens: inTok ?? 0,
          outputTokens: outTok ?? 0,
          usd: pickNum(a, keys.costUsd) ?? num(llmCost.total_cost) ?? 0,
        },
        latencyMs: durationMs,
      });
      // The captured answer itself. An llm_call has no room for text, so a chat span that recorded its output
      // (our own recorder dual-keys it; only string-shaped captures qualify) also projects the message a
      // judge's `kind === "message"` filter reads — the transcript projection used to provide it, and a turn
      // sealed from spans lost it entirely.
      const outputText = str(a[GEN_AI.outputMessages]) ?? str(a[EVERDICT_ATTR.output]);
      if (outputText !== undefined) {
        const role = str(a[EVERDICT_ATTR.messageRole]) === "user" ? "user" : "assistant";
        out.push({
          t: (endMs ?? startMs) - base,
          at: span.endedAt,
          kind: "message",
          role,
          text: outputText,
          parentId: span.spanId,
        });
      }
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
    } else if (
      str(a[EVERDICT_ATTR.envAction]) !== undefined &&
      // The observation channel's vocabulary is the platform's voice, sealed only by run-case — a pulled
      // span spelling it is a producer forging that voice (fabricate or suppress the sampled account). The
      // evidence is DEMOTED to the structural `span` arm below, name preserved: kept as bytes, stripped of
      // authority (review wave B; `isReservedObservationAction` is the one predicate).
      !isReservedObservationAction(asText(a[EVERDICT_ATTR.envAction]))
    ) {
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
