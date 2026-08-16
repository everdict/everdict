import { describe, expect, it } from "vitest";
import { type AgentTryMessage, tryMessagesToTrace } from "./agent-try.js";

describe("tryMessagesToTrace", () => {
  it("projects a try transcript into an ingestable TraceEvent stream (event → messages → tool call/result pairs)", () => {
    // Given a shadow-try transcript with a tool round-trip and a final answer
    const messages: AgentTryMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "get_scorecard", arguments: '{"id":"sc-1"}' }],
      },
      { role: "tool", content: '{"status":"succeeded"}', toolCallId: "x" },
      { role: "assistant", content: "The batch succeeded; 2 cases failed on login." },
    ];

    // When normalizing
    const trace = tryMessagesToTrace({ kind: "scorecard.completed", message: "Scorecard sc-1 succeeded" }, messages);

    // Then the stream opens with the waking event and pairs the tool call with its result by id
    expect(trace[0]).toMatchObject({
      kind: "message",
      role: "user",
      text: "[scorecard.completed] Scorecard sc-1 succeeded",
    });
    const call = trace.find((e) => e.kind === "tool_call");
    const result = trace.find((e) => e.kind === "tool_result");
    expect(call).toMatchObject({ name: "get_scorecard", args: { id: "sc-1" } });
    expect(result).toMatchObject({ ok: true });
    expect(call && result && "id" in call && "id" in result && call.id === result.id).toBe(true);
    expect(trace.at(-1)).toMatchObject({ kind: "message", role: "assistant" });
  });
});

// ── A WITHHELD CALL IS NOT A SUCCESSFUL ONE ──────────────────────────────────────────────────────────
//
// The try trace is the input to AGENT EVALS: `POST /scorecards/ingest` scores these events, and every trace
// grader that asks "did this agent's tools work" reads `tool_result.ok`. `tryMessagesToTrace` derives that
// flag from the tool message's TEXT — `!m.content.startsWith("Error")` — but the kernel's own refusal reads
// `Permission denied: the tool "…" was not approved by the user.` (loop.ts), which does not start with
// "Error" and therefore scores as a tool call that went fine.
//
// Shadow mode denies EVERY mutation by construction, so this is not an edge case in the try path: it is the
// try path's normal traffic. A shadow eval currently reports a perfect tool-success rate over a run in which
// every mutating call was refused, which is the one number the evaluation exists to produce.
//
// The fix is not a longer prefix list. The refusal is a fact the kernel already knows at the moment it makes
// it (it emits a `permission` event with the decision), and the transcript has to carry it rather than have
// the projector re-infer it from a sentence the kernel is free to reword.
describe.skip("tryMessagesToTrace — a denied tool call in the evaluation trace", () => {
  // [WAVE-6 COUNTEREXAMPLE #10] RED as of 02a3e15e: `AssertionError: expected { …, ok: true, … } to match
  // object { ok: false }` — apps/agent/src/agent-try.ts:147 infers ok from `!content.startsWith("Error")`, so
  // the kernel's "Permission denied: …" refusal is projected as a SUCCESSFUL tool result. Un-skip when wave 6
  // lands.
  it("marks a shadow-denied tool call as failed, so an agent eval cannot score a refusal as a success", () => {
    // Given a shadow transcript whose mutating call the try's deny-everything permit refused
    const messages: AgentTryMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "create_issue", arguments: '{"title":"Login is broken"}' }],
      },
      {
        role: "tool",
        content: 'Permission denied: the tool "create_issue" was not approved by the user.',
        toolCallId: "x",
      },
      { role: "assistant", content: "I would have filed the issue." },
    ];

    // When the transcript is projected into the ingestable trace
    const trace = tryMessagesToTrace({ kind: "issue.created", message: "Issue ISS-1 created" }, messages);

    // Then the refused call is a FAILED tool result — a trace grader must not read a withheld effect as a
    // working one.
    expect(trace.find((e) => e.kind === "tool_result")).toMatchObject({ ok: false });
  });
});
