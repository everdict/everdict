import type { AgentEvent } from "@everdict/agent-runtime";
import {
  EVERDICT_ATTR,
  GENAI_SEMCONV_VERSION,
  GEN_AI,
  GEN_AI_OPERATION,
  OTEL_ATTR,
  type SpanEvent,
  TRACE_PLANE,
  type TraceSpan,
  newSpanId,
} from "@everdict/contracts";
import type { AgentTurnUsage } from "./run-trace.js";

// The agent RECORDS its own spans as it works, instead of having them reconstructed afterwards.
//
// `transcriptToTrace` (run-trace.ts) projects a FINISHED turn from the persisted transcript rows. That is a
// faithful projection of what was persisted — and the persisted rows are only the conversation. Everything
// the loop did AROUND the conversation was invisible in the evidence: a model call's own latency, a retry
// waiting out an upstream failure, a fallback to a second model, a compaction that dropped half the context,
// a subagent that ran for a minute. All of it is already emitted live through the kernel's `onEvent`; nothing
// was listening for the trace.
//
// This is that listener. It is not assembly (`eventsToSpans`) — it is a recorder: the loop tells us when a
// thing starts and when it ends, so the spans are observed, not inferred, and they carry no
// `everdict.assembled` marker.
//
// See docs/architecture/otel-trace-model.md.

export interface TurnSpanContext {
  traceId: string;
  // The enclosing span when one exists — a chat turn hangs under nothing, an activation under its cause.
  parentSpanId?: string;
  agentName: string;
  conversationId?: string;
  model?: string;
  newSpanId?: () => string;
  now?: () => number;
}

// A span still being written: everything but its end.
interface Open {
  spanId: string;
  name: string;
  startMs: number;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  error?: string;
}

export class TurnSpanRecorder {
  private readonly newSpanId: () => string;
  private readonly now: () => number;
  private readonly rootId: string;
  private readonly startMs: number;
  private readonly common: Record<string, unknown>;
  private readonly closed: TraceSpan[] = [];
  private readonly rootEvents: SpanEvent[] = [];
  // Tool calls awaiting their result, by the model's own call id. A call with no id falls back to its name,
  // which is exactly as good as the kernel could tell us.
  private readonly openTools = new Map<string, Open>();
  private chat: Open | undefined;
  private readonly openSubagents = new Map<string, Open>();
  private stopReason: string | undefined;

  constructor(private readonly ctx: TurnSpanContext) {
    this.newSpanId = ctx.newSpanId ?? (() => newSpanId());
    this.now = ctx.now ?? (() => Date.now());
    this.rootId = this.newSpanId();
    this.startMs = this.now();
    this.common = {
      [EVERDICT_ATTR.plane]: TRACE_PLANE.agent,
      [EVERDICT_ATTR.semconv]: GENAI_SEMCONV_VERSION,
      ...(ctx.conversationId !== undefined ? { [GEN_AI.conversationId]: ctx.conversationId } : {}),
    };
  }

  observe(event: AgentEvent): void {
    const at = this.now();
    switch (event.type) {
      case "turn_start":
        // Each turn is one model call plus the tools it asked for. The chat span opens here and closes when
        // the model has spoken — which is the latency the old evidence never carried.
        this.chat = {
          spanId: this.newSpanId(),
          name: `${GEN_AI_OPERATION.chat} ${this.ctx.model ?? ""}`.trim(),
          startMs: at,
          attributes: {
            ...this.common,
            [GEN_AI.operationName]: GEN_AI_OPERATION.chat,
            ...(this.ctx.model !== undefined ? { [GEN_AI.requestModel]: this.ctx.model } : {}),
            turn: event.turn,
          },
          events: [],
        };
        break;
      case "assistant_message":
        if (this.chat) {
          this.chat.attributes[EVERDICT_ATTR.output] = event.content;
          this.close(this.chat, at);
          this.chat = undefined;
        }
        break;
      case "tool_call": {
        const key = event.id ?? event.name;
        this.openTools.set(key, {
          spanId: this.newSpanId(),
          name: `${GEN_AI_OPERATION.executeTool} ${event.name}`,
          startMs: at,
          attributes: {
            ...this.common,
            [GEN_AI.operationName]: GEN_AI_OPERATION.executeTool,
            [GEN_AI.toolName]: event.name,
            ...(event.id !== undefined ? { [GEN_AI.toolCallId]: event.id } : {}),
            [EVERDICT_ATTR.input]: event.args,
          },
          events: [],
        });
        break;
      }
      case "tool_result": {
        const key = event.id ?? event.name;
        const open = this.openTools.get(key);
        if (!open) break;
        this.openTools.delete(key);
        this.close(open, at, event.isError ? "tool reported an error" : undefined);
        break;
      }
      case "subagent":
        // A subagent is real nested work, so it is a real nested SPAN — not a note on the parent.
        if (event.phase === "launched") {
          this.openSubagents.set(event.id, {
            spanId: this.newSpanId(),
            name: `${GEN_AI_OPERATION.invokeAgent} ${event.id}`,
            startMs: at,
            attributes: {
              ...this.common,
              [GEN_AI.operationName]: GEN_AI_OPERATION.invokeAgent,
              [GEN_AI.agentName]: event.id,
            },
            events: [],
          });
        } else {
          const open = this.openSubagents.get(event.id);
          if (!open) break;
          this.openSubagents.delete(event.id);
          this.close(open, at, event.ok === false ? "subagent failed" : undefined);
        }
        break;
      // The rest are POINTS — they have no duration, which is precisely what a span event is for. Before
      // this recorder none of them reached the evidence at all.
      case "retry":
        this.point(at, "retry", {
          attempt: event.attempt,
          delayMs: event.delayMs,
          ...(event.persistent === true ? { persistent: true } : {}),
        });
        break;
      case "fallback":
        this.point(at, "model_fallback", { from: event.from, to: event.to });
        break;
      case "compaction":
        this.point(at, "compaction", {
          droppedMessages: event.droppedMessages,
          ...(event.mode !== undefined ? { mode: event.mode } : {}),
        });
        break;
      case "truncated":
        this.point(at, "truncated", { finishReason: event.finishReason });
        break;
      case "permission":
        this.point(at, "permission", { tool: event.name, decision: event.decision });
        break;
      case "input":
        this.point(at, "steering_input", { messages: event.messages });
        break;
      case "done":
        this.stopReason = event.stopReason;
        break;
      default:
        break; // text/reasoning deltas are the stream, not the record
    }
  }

  // Close the turn. Anything still open ended when the turn did — an aborted tool call is evidence of a tool
  // call that never returned, which is worth more than a span silently dropped.
  //
  // `failure` is the reason a turn DIED (an upstream model error, a dead tool session). A thrown turn is the
  // one a reader most needs to see, so it seals like any other — with its ending written down rather than
  // dropped on the floor.
  seal(usage?: AgentTurnUsage, failure?: string): TraceSpan[] {
    const endMs = this.now();
    if (this.chat) {
      this.close(this.chat, endMs);
      this.chat = undefined;
    }
    for (const open of this.openTools.values()) this.close(open, endMs, "the turn ended before this returned");
    this.openTools.clear();
    for (const open of this.openSubagents.values()) this.close(open, endMs, "the turn ended before this returned");
    this.openSubagents.clear();
    // The ending itself is a point in time — where the turn stopped is as much a part of the record as what
    // it did before that.
    if (failure !== undefined)
      this.rootEvents.push({
        name: "error",
        at: new Date(endMs).toISOString(),
        attributes: { [OTEL_ATTR.errorType]: failure },
      });

    const root: TraceSpan = {
      traceId: this.ctx.traceId,
      spanId: this.rootId,
      ...(this.ctx.parentSpanId !== undefined ? { parentSpanId: this.ctx.parentSpanId } : {}),
      name: `${GEN_AI_OPERATION.invokeAgent} ${this.ctx.agentName}`,
      kind: "internal",
      startedAt: new Date(this.startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      attributes: {
        ...this.common,
        [GEN_AI.operationName]: GEN_AI_OPERATION.invokeAgent,
        [GEN_AI.agentName]: this.ctx.agentName,
        ...(this.stopReason !== undefined ? { [GEN_AI.responseFinishReasons]: [this.stopReason] } : {}),
        // The turn's model spend. The agent counts tokens; the control plane prices them (one pricing table,
        // the same one the meter uses) — so no `everdict.cost.usd` is written here.
        ...(usage
          ? {
              [GEN_AI.responseModel]: usage.model,
              [GEN_AI.inputTokens]: usage.inputTokens,
              [GEN_AI.outputTokens]: usage.outputTokens,
            }
          : {}),
        ...(failure !== undefined ? { [OTEL_ATTR.errorType]: failure } : {}),
      },
      ...(this.rootEvents.length > 0 ? { events: this.rootEvents } : {}),
      // The turn ran to a stop reason, which is an OUTCOME, not a failure — `max_turns` and `interrupted` are
      // things that happened, and OTel already has the field for them (`gen_ai.response.finish_reasons`).
      // A turn that THREW seals here too, with the status that says so: the evidence a reader needs most is
      // the evidence of the turn that died.
      status: failure !== undefined ? { code: "error", message: failure } : { code: "ok" },
    };
    return [root, ...this.closed];
  }

  private close(open: Open, endMs: number, error?: string): void {
    this.closed.push({
      traceId: this.ctx.traceId,
      spanId: open.spanId,
      parentSpanId: this.rootId,
      name: open.name,
      kind: "internal",
      startedAt: new Date(open.startMs).toISOString(),
      endedAt: new Date(endMs >= open.startMs ? endMs : open.startMs).toISOString(),
      attributes: open.attributes,
      ...(open.events.length > 0 ? { events: open.events } : {}),
      status: error !== undefined ? { code: "error", message: error } : { code: "ok" },
    });
  }

  // A point lands on the innermost span it happened inside — a retry belongs to the model call it retried,
  // not to the turn at large.
  private point(at: number, name: string, attributes: Record<string, unknown>): void {
    const entry: SpanEvent = { name, at: new Date(at).toISOString(), attributes };
    if (this.chat) this.chat.events.push(entry);
    else this.rootEvents.push(entry);
  }
}
