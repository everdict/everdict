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

describe.skip("the kernel under a shadow try — a read-NAMED external tool still mutates", () => {
  // [WAVE-6 COUNTEREXAMPLE #9] RED as of 02a3e15e: `AssertionError: expected [ { title: 'Login is broken' } ] to
  // deeply equal []` — `tool.isReadOnly === true` with no consent-requiring effects skips `opts.permit` entirely
  // (packages/agent-runtime/src/kernel/loop.ts:1221), so the try's deny-everything hook is never consulted and the
  // external server creates the ticket for real. Un-skip when wave 6 lands.
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

    // When the run is a SHADOW try — the configuration `runAgentTry` uses to promise "no side effects"
    const denied: string[] = [];
    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "shadow",
      history,
      registry: new ToolRegistry([getOrCreateTicket]),
      permit: (request) => {
        denied.push(request.name);
        return "deny";
      },
    });

    // Then the ticket was never created. A try that files a ticket is not a try.
    expect(invocations).toEqual([]);
    // …and the run can SAY it withheld the call, rather than the refusal being invisible to the transcript.
    expect(denied).toContain("tracker__get_or_create_ticket");
  });
});
