import type { AgentMessageRecord, TraceEvent } from "@everdict/contracts";

// O2 (execution-model: "transcripts are traces"): project a turn's transcript slice onto the platform's
// normalized TraceEvent stream — the same projection idiom as tryMessagesToTrace (agent-automation B5), but
// over the PERSISTED AgentMessageRecord rows a real run produced. The transcript is already tool-call shaped,
// so this is a projection, not an inference: user/assistant text → message, assistant toolCalls → tool_call
// (real call ids), tool rows → tool_result paired by toolCallId. `t` is a monotonic step index (graders that
// need wall-clock read llm_call latency, which a transcript doesn't carry). Reasoning text stays display-only
// on the session record — it is not part of the evidence stream.
export function transcriptToTrace(messages: AgentMessageRecord[]): TraceEvent[] {
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
  return trace;
}
