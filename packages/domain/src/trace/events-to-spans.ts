import {
  EVERDICT_ATTR,
  GENAI_SEMCONV_VERSION,
  GEN_AI,
  GEN_AI_OPERATION,
  OTEL_ATTR,
  type TraceEvent,
  type TracePlane,
  type TraceSpan,
} from "@everdict/contracts";

// ASSEMBLY: a black-box harness's point-event stream → spans.
//
// Why this exists at all, when the point of N6 is that emitters produce spans: a harness is an agent under
// test driven over a PROCESS BOUNDARY. A CLI reports points as they happen, and the live playground needs
// those points before any span could close — so `EvaluableHarness.run()` keeps yielding `TraceEvent`, and the
// span layer is assembled from it here. Emitters that genuinely know their spans (the agent runtime, the
// dispatcher) build them directly and never come through this function.
//
// Assembly is inference, and it says so: every span it mints carries `everdict.assembled`. It is honest
// inference — a tool call and its result share an id, which is a fact the harness reported, not a guess.
//
// ALL-OR-NOTHING on time. If any event in the stream carries no absolute `at`, the whole assembly is refused
// (`undefined`) and the caller seals the events as they are. A partial tree is worse than no tree: it looks
// complete. This is exactly the self-reported `trace:file` case, where an agent numbered its steps 1,2,3 and
// told us nothing about when they happened.
//
// See docs/architecture/otel-trace-model.md.

export interface EventsToSpansContext {
  traceId: string;
  // The enclosing span, when one crossed the process boundary — the placement span the dispatcher opened.
  // Absent = this stream's root is the trace's root.
  parentSpanId?: string;
  // What ran. Becomes the root span's `gen_ai.agent.name` and its name (`invoke_agent <agent>`).
  agentName: string;
  plane?: TracePlane;
  resource?: Record<string, unknown>;
  // Injected so a test can assert on a tree; production passes the contracts' `newSpanId`.
  newSpanId: () => string;
}

function msOf(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}
const iso = (ms: number): string => new Date(ms).toISOString();

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function eventsToSpans(events: TraceEvent[], ctx: EventsToSpansContext): TraceSpan[] | undefined {
  if (events.length === 0) return undefined;
  const stamps = events.map((e) => msOf(e.at));
  if (stamps.some((ms) => ms === undefined)) return undefined; // all-or-nothing, see the header
  const at = (index: number): number => stamps[index] ?? 0;

  const base = { traceId: ctx.traceId, ...(ctx.resource ? { resource: ctx.resource } : {}) };
  const common = {
    [EVERDICT_ATTR.assembled]: true,
    [EVERDICT_ATTR.semconv]: GENAI_SEMCONV_VERSION,
    ...(ctx.plane ? { [EVERDICT_ATTR.plane]: ctx.plane } : {}),
  };

  // When each tool call's result arrived — its own length, which is the fact the pairing recovers.
  const resultAt = new Map<string, { ms: number; ok: boolean; output: string }>();
  events.forEach((event, index) => {
    if (event.kind === "tool_result") resultAt.set(event.id, { ms: at(index), ok: event.ok, output: event.output });
  });

  const rootId = ctx.newSpanId();
  const spans: TraceSpan[] = [];
  const rootEvents: TraceSpan["events"] = [];
  let sawError = false;

  events.forEach((event, index) => {
    const startMs = at(index);
    const child = {
      ...base,
      spanId: ctx.newSpanId(),
      parentSpanId: rootId,
      kind: "internal" as const,
      startedAt: iso(startMs),
    };

    switch (event.kind) {
      case "tool_call": {
        const result = resultAt.get(event.id);
        const endMs = result !== undefined && result.ms > startMs ? result.ms : startMs + (event.durationMs ?? 0);
        spans.push({
          ...child,
          name: `${GEN_AI_OPERATION.executeTool} ${event.name}`,
          endedAt: iso(endMs),
          attributes: {
            ...common,
            [GEN_AI.operationName]: GEN_AI_OPERATION.executeTool,
            [GEN_AI.toolName]: event.name,
            [GEN_AI.toolCallId]: event.id,
            ...(event.args === undefined ? {} : { [EVERDICT_ATTR.input]: textOf(event.args) }),
            ...(result ? { [EVERDICT_ATTR.output]: result.output } : {}),
          },
          ...(result && !result.ok
            ? { status: { code: "error" as const, message: result.output.slice(0, 2_000) } }
            : { status: { code: "ok" as const } }),
        });
        break;
      }
      case "tool_result":
        break; // folded into its call's span above — a result is not an interval of its own
      case "llm_call": {
        const endMs = startMs + (event.durationMs ?? event.latencyMs ?? 0);
        spans.push({
          ...child,
          name: `${GEN_AI_OPERATION.chat} ${event.model}`.trim(),
          endedAt: iso(endMs),
          attributes: {
            ...common,
            [GEN_AI.operationName]: GEN_AI_OPERATION.chat,
            ...(event.model === "" ? {} : { [GEN_AI.requestModel]: event.model }),
            ...(event.cost
              ? {
                  [GEN_AI.inputTokens]: event.cost.inputTokens,
                  [GEN_AI.outputTokens]: event.cost.outputTokens,
                  [EVERDICT_ATTR.costUsd]: event.cost.usd,
                }
              : {}),
          },
        });
        break;
      }
      case "message":
        spans.push({
          ...child,
          name: `message ${event.role}`,
          endedAt: iso(startMs),
          attributes: {
            ...common,
            [EVERDICT_ATTR.messageRole]: event.role,
            [EVERDICT_ATTR.output]: event.text,
          },
        });
        break;
      case "artifact":
        spans.push({
          ...child,
          name: event.name,
          endedAt: iso(startMs),
          attributes: {
            ...common,
            "artifact.ref": event.ref,
            "artifact.name": event.name,
            ...(event.mediaType ? { "artifact.media_type": event.mediaType } : {}),
            ...(event.role ? { "artifact.role": event.role } : {}),
          },
        });
        break;
      case "env_action":
        spans.push({
          ...child,
          name: event.action,
          endedAt: iso(startMs + (event.durationMs ?? 0)),
          attributes: {
            ...common,
            [EVERDICT_ATTR.envAction]: event.action,
            ...(event.detail === undefined ? {} : { [EVERDICT_ATTR.input]: textOf(event.detail) }),
          },
        });
        break;
      case "error":
        sawError = true;
        spans.push({
          ...child,
          name: "error",
          endedAt: iso(startMs),
          attributes: { ...common, [OTEL_ATTR.errorType]: "harness" },
          status: { code: "error", message: event.message },
        });
        break;
      case "log":
        // A log line is a POINT, which is what a span event is for. This is the distinction the flat model
        // could not draw, and the reason process output used to sit beside intervals as an equal.
        rootEvents.push({
          name: "log",
          at: iso(startMs),
          attributes: { [EVERDICT_ATTR.logStream]: event.stream, message: event.text },
        });
        break;
      default:
        // `span` (a structural step already normalized from someone else's tree) and `infra` (the placement
        // plane, which the dispatcher emits as real spans) pass through as structural spans.
        spans.push({
          ...child,
          name: event.kind === "span" ? event.name : event.kind,
          endedAt: iso(startMs + (event.durationMs ?? 0)),
          attributes: { ...common, ...(event.kind === "span" ? (event.attributes ?? {}) : {}) },
        });
    }
  });

  const startMs = Math.min(...stamps.map((ms) => ms ?? 0));
  const endMs = Math.max(...spans.map((s) => msOf(s.endedAt) ?? 0), ...stamps.map((ms) => ms ?? 0));
  spans.unshift({
    ...base,
    spanId: rootId,
    ...(ctx.parentSpanId !== undefined ? { parentSpanId: ctx.parentSpanId } : {}),
    name: `${GEN_AI_OPERATION.invokeAgent} ${ctx.agentName}`,
    kind: "internal",
    startedAt: iso(startMs),
    endedAt: iso(endMs),
    attributes: {
      ...common,
      [GEN_AI.operationName]: GEN_AI_OPERATION.invokeAgent,
      [GEN_AI.agentName]: ctx.agentName,
    },
    ...(rootEvents.length > 0 ? { events: rootEvents } : {}),
    status: { code: sawError ? "error" : "ok" },
  });
  return spans;
}
