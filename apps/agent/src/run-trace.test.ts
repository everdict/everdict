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

// A row at +ms from the turn's start — the transcript's own clock, which is what makes the evidence readable
// as a timeline instead of a list.
const at = (ms: number) => new Date(Date.parse("2026-07-30T00:00:00.000Z") + ms).toISOString();

describe("transcriptToTrace — the turn transcript projected as the platform TraceEvent stream (O2)", () => {
  it("projects user/assistant text, tool calls (real ids, parsed args), and tool results paired by toolCallId", () => {
    const trace = transcriptToTrace([
      record({ seq: 0, role: "user", content: "[scorecard.completed] pass rate dropped", createdAt: at(0) }),
      record({
        seq: 1,
        role: "assistant",
        content: "Looking at the failing cases.",
        toolCalls: [{ id: "call-1", name: "get_scorecard", arguments: '{"id":"sc-9"}' }],
        createdAt: at(1_200),
      }),
      record({
        seq: 2,
        role: "tool",
        content: '{"status":"succeeded"}',
        toolCallId: "call-1",
        name: "get_scorecard",
        createdAt: at(1_900),
      }),
    ]);
    expect(trace).toEqual([
      { t: 0, at: at(0), kind: "message", role: "user", text: "[scorecard.completed] pass rate dropped" },
      { t: 1_200, at: at(1_200), kind: "message", role: "assistant", text: "Looking at the failing cases." },
      // Real time, not a step index: `t` is ms from the turn's first row, and the call's length is when its
      // own result arrived (700ms) — the two facts a waterfall needs to draw a bar at all.
      {
        t: 1_200,
        at: at(1_200),
        kind: "tool_call",
        id: "call-1",
        name: "get_scorecard",
        args: { id: "sc-9" },
        spanId: "call-1",
        durationMs: 700,
      },
      // The result nests under the call it answers — the stream carries the tree it always was.
      {
        t: 1_900,
        at: at(1_900),
        kind: "tool_result",
        id: "call-1",
        ok: true,
        output: '{"status":"succeeded"}',
        parentId: "call-1",
      },
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
    expect(trace[0]).toMatchObject({ kind: "tool_call", id: "call-7", name: "run_case", args: "not-json" });
    expect(trace[1]).toMatchObject({ kind: "tool_result", id: "call-7", ok: false, parentId: "call-7" });
  });

  it("empty-content rows project nothing (no blank message events)", () => {
    expect(transcriptToTrace([record({ seq: 0, role: "assistant" })])).toEqual([]);
  });

  // The transcript is chat protocol — it records what was SAID, never that a model was called or what it cost.
  // Projecting it alone produced evidence in which the agent typed but never called a model, so `usage`
  // (derived from llm_call costs) read zero for exactly the runs that spend money.
  it("closes the stream with the turn's model call so the evidence carries its cost, spanning the turn", () => {
    const trace = transcriptToTrace(
      [
        record({ seq: 0, role: "user", content: "why?", createdAt: at(0) }),
        record({ seq: 1, role: "assistant", content: "done", createdAt: at(2_500) }),
      ],
      { model: "claude-sonnet-5", inputTokens: 900, outputTokens: 120 },
    );
    // usd stays 0 on the wire: the agent counts tokens, the control plane prices them at seal (one table).
    expect(trace[2]).toEqual({
      t: 2_500,
      at: at(2_500),
      kind: "llm_call",
      model: "claude-sonnet-5",
      cost: { inputTokens: 900, outputTokens: 120, usd: 0 },
      durationMs: 2_500,
    });
  });

  it("omits the model call when the turn consumed nothing (aborted before its first call)", () => {
    expect(transcriptToTrace([record({ seq: 0, role: "assistant", content: "done" })])).toEqual([
      { t: 0, at: at(0), kind: "message", role: "assistant", text: "done" },
    ]);
  });

  it("falls back to a step index when no row can be dated — never worse than the pre-timestamp projection", () => {
    const trace = transcriptToTrace([
      record({ seq: 0, role: "user", content: "hi", createdAt: "not-a-date" }),
      record({ seq: 1, role: "assistant", content: "hello", createdAt: "" }),
    ]);
    expect(trace).toEqual([
      { t: 0, kind: "message", role: "user", text: "hi" },
      { t: 1, kind: "message", role: "assistant", text: "hello" },
    ]);
  });
});
