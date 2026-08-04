import type { AgentEvent } from "@everdict/agent-runtime";
import { EVERDICT_ATTR, GEN_AI, GEN_AI_OPERATION, TRACE_PLANE } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { TurnSpanRecorder } from "./turn-spans.js";

// What this recorder is FOR: the transcript projection could only ever describe the conversation, so
// everything the loop did around it — the model call's own latency, a retry, a fallback, a compaction, a
// subagent — was absent from the evidence entirely. These tests are that absence, closed.

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const T0 = Date.parse("2026-08-04T09:00:00.000Z");

function recorder(ticks: number[]) {
  let i = 0;
  let n = 0;
  return new TurnSpanRecorder({
    traceId: TRACE_ID,
    agentName: "triage",
    conversationId: "conv-1",
    model: "claude-opus-5",
    newSpanId: () => (++n).toString(16).padStart(16, "0"),
    now: () => T0 + (ticks[i++] ?? ticks[ticks.length - 1] ?? 0),
  });
}

describe("recording a turn's spans live", () => {
  it("gives the model call its own span with a real length — the latency the transcript never held", () => {
    // now() ticks: construct(0) · turn_start(0) · assistant_message(1200) · seal(1300)
    const rec = recorder([0, 0, 1_200, 1_300]);
    rec.observe({ type: "turn_start", turn: 1 });
    rec.observe({ type: "assistant_message", content: "done" });
    const spans = rec.seal();

    const chat = spans.find((s) => s.name.startsWith(GEN_AI_OPERATION.chat));
    expect(chat).toBeDefined();
    expect(Date.parse(chat?.endedAt ?? "") - Date.parse(chat?.startedAt ?? "")).toBe(1_200);
    expect(chat?.attributes[GEN_AI.requestModel]).toBe("claude-opus-5");
    expect(chat?.attributes[EVERDICT_ATTR.output]).toBe("done");
  });

  it("pairs a tool result with its call by the model's OWN id, so parallel calls cannot cross", () => {
    const rec = recorder([0, 0, 10, 20, 900, 400, 1_000]);
    rec.observe({ type: "turn_start", turn: 1 });
    rec.observe({ type: "tool_call", name: "Bash", args: "{}", id: "call-a" });
    rec.observe({ type: "tool_call", name: "Bash", args: "{}", id: "call-b" });
    // b finishes FIRST — a name-keyed pairing would close a with b's timestamp.
    rec.observe({ type: "tool_result", name: "Bash", isError: false, id: "call-b" });
    rec.observe({ type: "tool_result", name: "Bash", isError: true, id: "call-a" });
    const spans = rec.seal();

    const byId = new Map(
      spans.filter((s) => s.attributes[GEN_AI.toolCallId]).map((s) => [s.attributes[GEN_AI.toolCallId], s]),
    );
    const a = byId.get("call-a");
    const b = byId.get("call-b");
    expect(Date.parse(b?.endedAt ?? "") - Date.parse(b?.startedAt ?? "")).toBe(880);
    expect(Date.parse(a?.endedAt ?? "") - Date.parse(a?.startedAt ?? "")).toBe(390);
    expect(a?.status?.code).toBe("error"); // the failing one, and only it
    expect(b?.status?.code).toBe("ok");
  });

  it("keeps a retry, a fallback and a compaction as span EVENTS on the model call they happened inside", () => {
    const rec = recorder([0, 0, 100, 200, 300, 1_000, 1_100]);
    rec.observe({ type: "turn_start", turn: 1 });
    rec.observe({ type: "retry", attempt: 1, delayMs: 2_000, persistent: true });
    rec.observe({ type: "fallback", from: "claude-opus-5", to: "claude-sonnet-5" });
    rec.observe({ type: "compaction", droppedMessages: 12, mode: "summarize" });
    rec.observe({ type: "assistant_message", content: "ok" });
    const chat = rec.seal().find((s) => s.name.startsWith(GEN_AI_OPERATION.chat));

    expect(chat?.events?.map((e) => e.name)).toEqual(["retry", "model_fallback", "compaction"]);
    expect(chat?.events?.[0]?.attributes).toMatchObject({ attempt: 1, delayMs: 2_000, persistent: true });
    expect(chat?.events?.[2]?.attributes).toMatchObject({ droppedMessages: 12, mode: "summarize" });
  });

  it("makes a subagent real nested work — a span, not a note on the parent", () => {
    const rec = recorder([0, 0, 5_000, 6_000]);
    rec.observe({ type: "subagent", id: "sub-1", phase: "launched" });
    rec.observe({ type: "subagent", id: "sub-1", phase: "done", ok: true });
    const spans = rec.seal();

    const sub = spans.find((s) => s.name === `${GEN_AI_OPERATION.invokeAgent} sub-1`);
    expect(Date.parse(sub?.endedAt ?? "") - Date.parse(sub?.startedAt ?? "")).toBe(5_000);
    expect(sub?.parentSpanId).toBe(spans[0]?.spanId);
  });

  it("closes what the turn left open rather than dropping it — a call that never returned is evidence", () => {
    const rec = recorder([0, 0, 10, 4_000]);
    rec.observe({ type: "turn_start", turn: 1 });
    rec.observe({ type: "tool_call", name: "Bash", args: "{}", id: "call-a" });
    const spans = rec.seal();

    const tool = spans.find((s) => s.attributes[GEN_AI.toolCallId] === "call-a");
    expect(tool?.status).toMatchObject({ code: "error", message: expect.stringContaining("ended before") });
  });

  it("roots the turn with the plane, conversation, finish reason and what it spent", () => {
    const rec = recorder([0, 0, 100, 200]);
    rec.observe({ type: "turn_start", turn: 1 });
    rec.observe({ type: "done", stopReason: "end_turn" });
    const root = rec.seal({ model: "claude-opus-5", inputTokens: 120, outputTokens: 40 })[0];

    expect(root?.name).toBe(`${GEN_AI_OPERATION.invokeAgent} triage`);
    expect(root?.attributes[EVERDICT_ATTR.plane]).toBe(TRACE_PLANE.agent);
    expect(root?.attributes[GEN_AI.conversationId]).toBe("conv-1");
    expect(root?.attributes[GEN_AI.responseFinishReasons]).toEqual(["end_turn"]);
    expect(root?.attributes[GEN_AI.inputTokens]).toBe(120);
    // Price is the control plane's to compute — the agent counts tokens, the domain prices them.
    expect(root?.attributes[EVERDICT_ATTR.costUsd]).toBeUndefined();
  });

  it("records nothing it inferred — these spans were observed, so they carry no assembled marker", () => {
    const rec = recorder([0, 0, 100]);
    rec.observe({ type: "turn_start", turn: 1 });
    expect(rec.seal().every((s) => s.attributes[EVERDICT_ATTR.assembled] === undefined)).toBe(true);
  });

  it("ignores the stream — text and reasoning deltas are not the record", () => {
    const rec = recorder([0, 0, 1, 2, 3]);
    rec.observe({ type: "turn_start", turn: 1 });
    rec.observe({ type: "text_delta", delta: "hel" });
    rec.observe({ type: "reasoning_delta", delta: "hmm" });
    const spans = rec.seal();
    expect(spans).toHaveLength(2); // the root + the one chat span
  });
});

// A turn with no run to belong to records nothing at all — the caller falls back to the transcript projection.
describe("what the recorder refuses", () => {
  it("still seals a root for a turn where nothing happened, so an empty run is not a missing one", () => {
    const spans = recorder([0, 5]).seal();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status?.code).toBe("ok");
  });
});

// Kept honest against the kernel's own union: an event this recorder does not handle must not throw.
it("survives every AgentEvent shape the kernel can emit", () => {
  const rec = recorder([0]);
  const events: AgentEvent[] = [
    { type: "turn_start", turn: 1 },
    { type: "text_delta", delta: "x" },
    { type: "reasoning_delta", delta: "x" },
    { type: "assistant_message", content: "x" },
    { type: "tool_call", name: "t", args: "{}" },
    { type: "tool_result", name: "t", isError: false },
    { type: "permission", name: "t", decision: "allow" },
    { type: "plan", plan: "p" },
    { type: "input", messages: 1 },
    { type: "subagent", id: "s", phase: "launched" },
    { type: "subagent", id: "s", phase: "done", ok: true },
    { type: "fallback", from: "a", to: "b" },
    { type: "compaction", droppedMessages: 1 },
    { type: "retry", attempt: 1, delayMs: 1 },
    { type: "truncated", finishReason: "length" },
    { type: "done", stopReason: "end_turn" },
  ];
  expect(() => {
    for (const e of events) rec.observe(e);
    rec.seal();
  }).not.toThrow();
});
