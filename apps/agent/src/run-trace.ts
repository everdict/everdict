import type { AgentMessageRecord, TraceEvent } from "@everdict/contracts";

// O2 (execution-model: "transcripts are traces"): project a turn's transcript slice onto the platform's
// normalized TraceEvent stream — the same projection idiom as tryMessagesToTrace (agent-automation B5), but
// over the PERSISTED AgentMessageRecord rows a real run produced. The transcript is already tool-call shaped,
// so this is a projection, not an inference: user/assistant text → message, assistant toolCalls → tool_call
// (real call ids), tool rows → tool_result paired by toolCallId. `t` is a monotonic step index (graders that
// need wall-clock read llm_call latency, which a transcript doesn't carry). Reasoning text stays display-only
// on the session record — it is not part of the evidence stream.
// What one turn spent on the model. The meter (billing) and the ledger (evidence) take the SAME numbers from
// the loop's counters, so there is one type rather than two shapes drifting apart.
export interface AgentTurnUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export function transcriptToTrace(
  messages: AgentMessageRecord[],
  // What the turn spent on the model. The transcript rows do not carry it (they are chat protocol, not
  // telemetry), so the loop's own counters ride in separately and become ONE llm_call event closing the
  // stream. Without this the evidence says the agent typed but never called a model, and `usage` — derived
  // from llm_call costs — reads zero for exactly the runs that cost money. `usd` is left to the control
  // plane: the agent counts tokens, the domain prices them (one pricing table, same as the meter).
  usage?: AgentTurnUsage,
): TraceEvent[] {
  const trace: TraceEvent[] = [];
  let t = 0;
  for (const m of messages) {
    if (m.role === "user") {
      if (m.content.length > 0) trace.push({ t: t++, kind: "message", role: "user", text: m.content });
    } else if (m.role === "assistant") {
      if (m.content.length > 0) trace.push({ t: t++, kind: "message", role: "assistant", text: m.content });
      for (const call of m.toolCalls ?? []) {
        let args: unknown = call.arguments;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          // Keep the raw string — the model produced non-JSON arguments.
        }
        trace.push({ t: t++, kind: "tool_call", id: call.id, name: call.name, args });
      }
    } else {
      trace.push({
        t: t++,
        kind: "tool_result",
        id: m.toolCallId ?? `call-${t}`,
        ok: !m.content.startsWith("Error"),
        output: m.content,
      });
    }
  }
  if (usage)
    trace.push({
      t: t++,
      kind: "llm_call",
      model: usage.model,
      cost: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, usd: 0 },
    });
  return trace;
}
