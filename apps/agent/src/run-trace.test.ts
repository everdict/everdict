import type { AgentMessageRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { transcriptToTrace } from "./run-trace.js";

const record = (over: Partial<AgentMessageRecord> & Pick<AgentMessageRecord, "seq" | "role">): AgentMessageRecord => ({
  id: `m-${over.seq}`,
  tenant: "acme",
  sessionId: "sess-1",
  content: "",
  createdAt: "2026-07-30T00:00:00.000Z",
  ...over,
});

describe("transcriptToTrace — the turn transcript projected as the platform TraceEvent stream (O2)", () => {
  it("projects user/assistant text, tool calls (real ids, parsed args), and tool results paired by toolCallId", () => {
    const trace = transcriptToTrace([
      record({ seq: 0, role: "user", content: "[scorecard.completed] pass rate dropped" }),
      record({
        seq: 1,
        role: "assistant",
        content: "Looking at the failing cases.",
        toolCalls: [{ id: "call-1", name: "get_scorecard", arguments: '{"id":"sc-9"}' }],
      }),
      record({ seq: 2, role: "tool", content: '{"status":"succeeded"}', toolCallId: "call-1", name: "get_scorecard" }),
    ]);
    expect(trace).toEqual([
      { t: 0, kind: "message", role: "user", text: "[scorecard.completed] pass rate dropped" },
      { t: 1, kind: "message", role: "assistant", text: "Looking at the failing cases." },
      { t: 2, kind: "tool_call", id: "call-1", name: "get_scorecard", args: { id: "sc-9" } },
      { t: 3, kind: "tool_result", id: "call-1", ok: true, output: '{"status":"succeeded"}' },
    ]);
  });

  it("keeps non-JSON tool arguments as the raw string and marks Error-prefixed tool output as failed", () => {
    const trace = transcriptToTrace([
      record({
        seq: 0,
        role: "assistant",
        toolCalls: [{ id: "call-7", name: "run_case", arguments: "not-json" }],
      }),
      record({ seq: 1, role: "tool", content: "Error: dataset not found", toolCallId: "call-7" }),
    ]);
    expect(trace[0]).toEqual({ t: 0, kind: "tool_call", id: "call-7", name: "run_case", args: "not-json" });
    expect(trace[1]).toMatchObject({ kind: "tool_result", id: "call-7", ok: false });
  });

  it("empty-content rows project nothing (no blank message events)", () => {
    expect(transcriptToTrace([record({ seq: 0, role: "assistant" })])).toEqual([]);
  });

  // The transcript is chat protocol — it records what was SAID, never that a model was called or what it cost.
  // Projecting it alone produced evidence in which the agent typed but never called a model, so `usage`
  // (derived from llm_call costs) read zero for exactly the runs that spend money.
  it("closes the stream with the turn's model call so the evidence carries its cost", () => {
    const trace = transcriptToTrace([record({ seq: 0, role: "assistant", content: "done" })], {
      model: "claude-sonnet-5",
      inputTokens: 900,
      outputTokens: 120,
    });
    expect(trace).toEqual([
      { t: 0, kind: "message", role: "assistant", text: "done" },
      // usd stays 0 on the wire: the agent counts tokens, the control plane prices them at seal (one table).
      { t: 1, kind: "llm_call", model: "claude-sonnet-5", cost: { inputTokens: 900, outputTokens: 120, usd: 0 } },
    ]);
  });

  it("omits the model call when the turn consumed nothing (aborted before its first call)", () => {
    expect(transcriptToTrace([record({ seq: 0, role: "assistant", content: "done" })])).toEqual([
      { t: 0, kind: "message", role: "assistant", text: "done" },
    ]);
  });
});
