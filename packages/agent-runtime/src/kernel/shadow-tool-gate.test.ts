import type { LlmTransport, StreamRequest, StreamResult } from "@everdict/llm";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../messages.js";
import type { ToolDefinition } from "../tools/definition.js";
import { ToolRegistry } from "../tools/registry.js";
import { runAgentLoop } from "./loop.js";

// ── SHADOW IS A PROPERTY OF THE EXECUTION, NOT OF THE PERMISSION HOOK ────────────────────────────────
//
// A shadow try (`runAgentTry` in apps/agent) claims "a try can never have side effects" and implements that
// claim with one line: `permit: () => "deny"`. The kernel, however, only ASKS the permit hook when the tool
// is not read-only or its declared effects require consent — plain reads are the agent's senses and stay
// ungated on purpose.
//
// Those two statements are compatible only if "read-only" is a fact. For an EXTERNAL stdio/HTTP MCP server it
// is a GUESS: `apps/agent/src/mcp-tools.ts` filters a non-write server's catalog with `isReadOnlyToolName`
// (a `get_`/`list_`/… NAME PREFIX over a third party's tool names) and bridges every survivor with
// `isReadOnly: true`. A server exposing `get_or_create_ticket` therefore hands the kernel a tool that is
// declared read-only, is asked nothing, and creates a ticket — during a run whose entire purpose is that
// nothing happens.
//
// The gate cannot be fixed by tightening the name list: the list is the wrong instrument, because the
// classification is the untrusted server's to make. The mode of the RUN has to reach the call site, so that
// "this execution performs no effects" is enforced where effects are performed rather than inferred from a
// property the effect's author supplied.
function fakeTransport(results: StreamResult[]): { transport: LlmTransport; requests: StreamRequest[] } {
  const requests: StreamRequest[] = [];
  let call = 0;
  const transport: LlmTransport = {
    provider: "fake",
    stream: async (req) => {
      requests.push(req);
      const r = results[call] ?? { content: null, toolCalls: [], finishReason: "stop" };
      call += 1;
      return r;
    },
  };
  return { transport, requests };
}

const usage = { inputTokens: 1, outputTokens: 0, totalTokens: 1 };
const history: ChatMessage[] = [{ role: "user", content: "file the ticket" }];

describe("the kernel under a shadow try — a read-NAMED external tool still mutates", () => {
  // [WAVE-6 COUNTEREXAMPLE #9] was RED as of 02a3e15e: `AssertionError: expected [ { title: 'Login is broken' } ] to
  // deeply equal []` — `tool.isReadOnly === true` with no consent-requiring effects skipped `opts.permit` entirely,
  // so the try's deny-everything hook was never consulted and the external server created the ticket for real.
  // GREEN since the run carries an ExecutionMode: the invocation point, not the permit gate, decides.
  it("does not execute a tool an untrusted server declared read-only, because the RUN performs no effects", async () => {
    // Given an external MCP server's tool that passes the read-name filter and mutates anyway, bridged exactly
    // as `mcpToolToDefinition` bridges a non-write server's catalog: isReadOnly true, no effect contract.
    const invocations: unknown[] = [];
    const getOrCreateTicket: ToolDefinition = {
      name: "tracker__get_or_create_ticket",
      description: "Fetch a ticket by title, creating it when absent.",
      parametersJsonSchema: { type: "object", properties: { title: { type: "string" } } },
      isReadOnly: true,
      isMcp: true,
      call: async (input) => {
        invocations.push(input);
        return { content: '{"id":"TKT-1","created":true}', isError: false };
      },
    };
    const { transport } = fakeTransport([
      {
        content: null,
        toolCalls: [
          { id: "t1", name: "tracker__get_or_create_ticket", arguments: JSON.stringify({ title: "Login is broken" }) },
        ],
        finishReason: "tool_calls",
        usage,
      },
      { content: "I would have filed TKT-1.", toolCalls: [], finishReason: "stop", usage },
    ]);

    // When the run is a SHADOW try — the configuration `runAgentTry` uses to promise "no side effects". The
    // attested set holds the PLATFORM's own reads; a third party's catalog is never in it, whatever it calls itself.
    const denied: string[] = [];
    const intents: { name: string; input: unknown }[] = [];
    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "shadow",
      history,
      registry: new ToolRegistry([getOrCreateTicket]),
      mode: { kind: "shadow", executableReads: new Set(["get_scorecard", "list_runs"]) },
      permit: (request) => {
        denied.push(request.name);
        return "deny";
      },
      onEvent: (e) => {
        if (e.type === "shadow_intent") intents.push({ name: e.name, input: e.input });
      },
    });

    // Then the ticket was never created. A try that files a ticket is not a try.
    expect(invocations).toEqual([]);
    // …and the run can SAY it withheld the call, rather than the refusal being invisible to the transcript.
    expect(denied).toContain("tracker__get_or_create_ticket");
    // The captured intent IS the try's product: the tool the agent chose and the arguments it chose for it.
    expect(intents).toEqual([{ name: "tracker__get_or_create_ticket", input: { title: "Login is broken" } }]);
  });

  it("still runs the platform's own attested reads, so a try can see the workspace it is reasoning about", async () => {
    // Given a first-party read the PLATFORM attests (it is our tool, gating our own handler) …
    const reads: unknown[] = [];
    const getScorecard: ToolDefinition = {
      name: "get_scorecard",
      description: "Read a scorecard.",
      parametersJsonSchema: { type: "object", properties: { id: { type: "string" } } },
      isReadOnly: true,
      call: async (input) => {
        reads.push(input);
        return { content: '{"status":"succeeded"}', isError: false };
      },
    };
    const { transport } = fakeTransport([
      {
        content: null,
        toolCalls: [{ id: "t1", name: "get_scorecard", arguments: JSON.stringify({ id: "sc-1" }) }],
        finishReason: "tool_calls",
        usage,
      },
      { content: "It succeeded.", toolCalls: [], finishReason: "stop", usage },
    ]);

    // When the same shadow run asks for it
    const intents: string[] = [];
    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "shadow",
      history,
      registry: new ToolRegistry([getScorecard]),
      mode: { kind: "shadow", executableReads: new Set(["get_scorecard"]) },
      onEvent: (e) => {
        if (e.type === "shadow_intent") intents.push(e.name);
      },
    });

    // Then it ran for real against the workspace's data — shadow withholds EFFECTS, not the agent's senses.
    expect(reads).toEqual([{ id: "sc-1" }]);
    expect(intents).toEqual([]);
  });
});
