import { isKernelRefusal } from "@everdict/agent-runtime";
import type { AgentMessageRecord, TraceEvent } from "@everdict/contracts";

// O2 (execution-model: "transcripts are traces"): project a turn's transcript slice onto the platform's
// normalized TraceEvent stream — the same projection idiom as tryMessagesToTrace (agent-automation B5), but
// over the PERSISTED AgentMessageRecord rows a real run produced. The transcript is already tool-call shaped,
// so this is a projection, not an inference: user/assistant text → message, assistant toolCalls → tool_call
// (real call ids), tool rows → tool_result paired by toolCallId. Reasoning text stays display-only on the
// session record — it is not part of the evidence stream.
//
// TIME is real here (it used to be a step counter, 0,1,2…). A transcript row carries `createdAt`, so `t` is
// milliseconds from the turn's first row and `at` is the absolute instant — which is what lets a reader lay
// this plane on a shared axis at all. Before this, an agent turn sealed with no anchor and no durations, so
// the trace viewer could only draw a list: no timeline, no bars. A tool call's `durationMs` is its own
// result's arrival, which the transcript knows exactly.
//
// STRUCTURE is real too: a tool result hangs under the call it answers (`parentId`), so the stream reads as
// the tree it always was instead of a flat sequence.

// What one turn spent on the model. The meter (billing) and the ledger (evidence) take the SAME numbers from
// the loop's counters, so there is one type rather than two shapes drifting apart.
export interface AgentTurnUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

function msOf(iso: string): number | undefined {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  // The turn's own t0 — every `t` counts from the first row we can date. A transcript with no datable row
  // keeps a step index, which is what this projection always produced (never worse than before).
  const stamps = messages.map((m) => msOf(m.createdAt));
  const base = stamps.find((ms): ms is number => ms !== undefined);
  let step = 0; // the pre-timestamp fallback: used only when NO row in the turn can be dated
  let lastT = 0;
  const at = (index: number): { t: number; at?: string } => {
    const ms = stamps[index];
    if (base === undefined) return { t: step++ };
    if (ms === undefined) return { t: lastT }; // an undatable row sits where the last datable one did
    lastT = ms - base;
    return { t: lastT, at: new Date(ms).toISOString() };
  };
  // When a tool result arrived, by the call id it answers — a tool_call's own length.
  const resultAt = new Map<string, number>();
  messages.forEach((m, index) => {
    const ms = stamps[index];
    if (m.role !== "assistant" && m.toolCallId !== undefined && ms !== undefined) resultAt.set(m.toolCallId, ms);
  });

  messages.forEach((m, index) => {
    const stamp = at(index);
    if (m.role === "user") {
      if (m.content.length > 0) trace.push({ ...stamp, kind: "message", role: "user", text: m.content });
    } else if (m.role === "assistant") {
      if (m.content.length > 0) trace.push({ ...stamp, kind: "message", role: "assistant", text: m.content });
      for (const call of m.toolCalls ?? []) {
        let args: unknown = call.arguments;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          // Keep the raw string — the model produced non-JSON arguments.
        }
        const end = resultAt.get(call.id);
        const started = stamps[index];
        trace.push({
          ...stamp,
          kind: "tool_call",
          id: call.id,
          name: call.name,
          args,
          spanId: call.id, // the call IS the span; its result nests under it
          ...(end !== undefined && started !== undefined && end > started ? { durationMs: end - started } : {}),
        });
      }
    } else {
      const id = m.toolCallId ?? `call-${index}`;
      trace.push({
        ...stamp,
        kind: "tool_result",
        id,
        // A REFUSAL IS NOT A SUCCESS — and the row now SAYS which it was. `isError` is what the kernel observed
        // at the moment it produced the result (mig 0202), so this projection reads a recorded fact instead of
        // re-deriving one from rendered text, which rule `protocol` L3 bans by name ("log text → outcome").
        //
        // The text check survives for rows written BEFORE that column and for nothing else. It is the weaker
        // answer on purpose: it reads the kernel's own refusal constants (isKernelRefusal: permission denial,
        // envelope refusal, a shadow capture) rather than a prefix somebody guessed, so a reword moves both ends
        // together — but a tool whose OUTPUT quotes "Error" or a permission problem is still miscounted there,
        // which is exactly why it is a fallback and not the rule. Absent is not success: it means this row
        // predates the field, so the weaker reading applies rather than an invented pass.
        ok: m.isError !== undefined ? !m.isError : !(m.content.startsWith("Error") || isKernelRefusal(m.content)),
        output: m.content,
        parentId: id,
      });
    }
  });
  if (usage) {
    // The turn's model spend, closing the stream — it spans the whole turn rather than sitting at an instant.
    const last = [...stamps].reverse().find((ms): ms is number => ms !== undefined);
    trace.push({
      t: base !== undefined && last !== undefined ? last - base : step++,
      ...(last !== undefined ? { at: new Date(last).toISOString() } : {}),
      kind: "llm_call",
      model: usage.model,
      cost: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, usd: 0 },
      ...(base !== undefined && last !== undefined && last > base ? { durationMs: last - base } : {}),
    });
  }
  return trace;
}
