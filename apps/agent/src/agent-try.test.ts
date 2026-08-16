import { type ToolDefinition, ToolRegistry } from "@everdict/agent-runtime";
import type { LlmTransport, StreamResult } from "@everdict/llm";
import { describe, expect, it } from "vitest";
import { type AgentTryMessage, runAgentTry, tryMessagesToTrace } from "./agent-try.js";
import type { ToolProvider } from "./mcp-tools.js";

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

function fakeTransport(results: StreamResult[]): LlmTransport {
  let call = 0;
  return {
    provider: "fake",
    stream: async () => {
      const r = results[call] ?? { content: null, toolCalls: [], finishReason: "stop" };
      call += 1;
      return r;
    },
  };
}

const usage = { inputTokens: 1, outputTokens: 0, totalTokens: 1 };

describe("runAgentTry — the try's promise is the run's MODE", () => {
  it("executes the attested platform read and captures the external tool the workspace server called read-only", async () => {
    // Given a workspace-registered server whose `get_or_create_*` tool passed the read-name filter and mutates
    // anyway, alongside one of the control plane's own reads
    const ran: string[] = [];
    const external: ToolDefinition = {
      name: "mcp__tracker__get_or_create_ticket",
      description: "Fetch a ticket by title, creating it when absent.",
      parametersJsonSchema: { type: "object", properties: { title: { type: "string" } } },
      isReadOnly: true,
      isMcp: true,
      call: async () => {
        ran.push("mcp__tracker__get_or_create_ticket");
        return { content: '{"id":"TKT-1"}', isError: false };
      },
    };
    const platformRead: ToolDefinition = {
      name: "get_scorecard",
      description: "Read a scorecard.",
      parametersJsonSchema: { type: "object", properties: { id: { type: "string" } } },
      isReadOnly: true,
      call: async () => {
        ran.push("get_scorecard");
        return { content: '{"status":"succeeded"}', isError: false };
      },
    };
    const toolProvider: ToolProvider = async () => ({
      registry: new ToolRegistry([external, platformRead]),
      call: null,
      attestedReads: new Set(["get_scorecard"]),
      close: async () => {},
    });
    const transport = fakeTransport([
      {
        content: null,
        toolCalls: [{ id: "c1", name: "get_scorecard", arguments: '{"id":"sc-1"}' }],
        finishReason: "tool_calls",
        usage,
      },
      {
        content: null,
        toolCalls: [{ id: "c2", name: "mcp__tracker__get_or_create_ticket", arguments: '{"title":"Login is broken"}' }],
        finishReason: "tool_calls",
        usage,
      },
      { content: "I read sc-1 and would have filed a ticket.", toolCalls: [], finishReason: "stop", usage },
    ]);

    // When the draft is tried against a simulated event
    const result = await runAgentTry(
      {
        toolProvider,
        resolveModel: async () => ({ transport, model: "m" }),
        systemPrompt: "base",
      },
      { subject: "alice", workspace: "acme", roles: ["member"] },
      { authorization: "Bearer x" },
      { draft: { instructions: "watch scorecards" } },
      { kind: "scorecard.completed", message: "Scorecard sc-1 succeeded" },
    );

    // Then only the attested read ran; the external tool was captured as an intent, arguments and all
    expect(ran).toEqual(["get_scorecard"]);
    expect(result.wouldHave).toEqual([
      { name: "mcp__tracker__get_or_create_ticket", input: { title: "Login is broken" } },
    ]);
    // …and the ingestable trace tells the two apart: the read succeeded, the withheld call did not.
    const results = result.trace.filter((e) => e.kind === "tool_result");
    expect(results.map((e) => ("ok" in e ? e.ok : undefined))).toEqual([true, false]);
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
// try path's normal traffic. A shadow eval reported a perfect tool-success rate over a run in which every
// mutating call was refused, which is the one number the evaluation exists to produce.
//
// The fix is not a longer prefix list. The refusal is a fact the kernel already knows at the moment it makes
// it (it emits a `permission` event with the decision), and the transcript has to carry it rather than have
// the projector re-infer it from a sentence the kernel is free to reword.
describe("tryMessagesToTrace — a denied tool call in the evaluation trace", () => {
  // [WAVE-6 COUNTEREXAMPLE #10] was RED as of 02a3e15e: `AssertionError: expected { …, ok: true, … } to match
  // object { ok: false }` — the projector inferred ok from `!content.startsWith("Error")`, so the kernel's
  // "Permission denied: …" refusal was projected as a SUCCESSFUL tool result. GREEN since the outcome is the
  // kernel's to state (`isError` off the tool_result event) and the text fallback recognizes the kernel's own
  // refusal constants.
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

  it("takes the outcome from the kernel's own account of the call, not from how the result reads", () => {
    // Given a transcript the LOOP attributed: a captured call (the kernel never invoked it) and a read that ran and
    // came back with text that happens to look like an error report.
    const messages: AgentTryMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { name: "mcp__tracker__get_or_create_ticket", arguments: '{"title":"Login is broken"}' },
          { name: "get_scorecard", arguments: '{"id":"sc-1"}' },
        ],
      },
      {
        role: "tool",
        content: 'Shadow run — this call was captured, not executed. "mcp__tracker__get_or_create_ticket" did NOT run',
        toolCallId: "a",
        isError: true,
        outcome: "shadow_denied",
      },
      { role: "tool", content: "Error budget: 3 cases failed", toolCallId: "b", isError: false },
    ];

    // When projected
    const results = tryMessagesToTrace({ kind: "issue.created", message: "Issue ISS-1 created" }, messages).filter(
      (e) => e.kind === "tool_result",
    );

    // Then the captured call failed and the read that actually ran succeeded — neither answer came from the text.
    expect(results.map((e) => ("ok" in e ? e.ok : undefined))).toEqual([false, true]);
  });
});
