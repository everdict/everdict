import type { LlmTransport, StreamRequest, StreamResult } from "@everdict/llm";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../messages.js";
import type { PermissionRequest, ToolDefinition } from "../tools/definition.js";
import { ToolRegistry } from "../tools/registry.js";
import { runAgentLoop } from "./loop.js";

// Trust suite (docs/trust-certification.md) — TRUST-134.
//
// THE LOOP'S OWN REFUSALS, CERTIFIED WHERE THEY HAPPEN.
//
// TRUST-10 certifies the envelope at the CONTROL PLANE — the admission gate every lane that takes compute
// must pass — and TRUST-14 certifies the decision functions. Neither runs the loop. Two claims the roadmap
// listed as covered by unit tests only, which is a weaker claim than the rest of this page makes:
//
//   ① an out-of-scope capability is refused MID-TURN while the run continues. A refusal that killed the turn
//      would make every scope violation a lost run, and an agent whose only response to a boundary is death
//      cannot replan — which is the behaviour the envelope's own vocabulary (`refuse_and_replan`) promises.
//   ② a benign-NAMED capability that declares external, non-idempotent effects still asks. Read-only and
//      safe-without-consent are different claims, and a system that reads risk off a tool's spelling rather
//      than off its author's declaration can be walked past by naming a thing well.
//
// Both are driven through the real loop against a faked transport — the harness the roadmap said these
// scenarios were waiting for.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

function fakeTransport(results: StreamResult[]): { transport: LlmTransport; requests: StreamRequest[] } {
  const requests: StreamRequest[] = [];
  let call = 0;
  return {
    requests,
    transport: {
      provider: "fake",
      stream: async (req) => {
        requests.push(req);
        const r = results[call] ?? { content: null, toolCalls: [], finishReason: "stop" };
        call += 1;
        return r;
      },
    },
  };
}

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const calls = (list: Array<{ id: string; name: string; args: string }>): StreamResult => ({
  content: null,
  toolCalls: list.map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
  finishReason: "tool_calls",
  usage,
});
const text = (content: string): StreamResult => ({ content, toolCalls: [], finishReason: "stop", usage });

const history: ChatMessage[] = [{ role: "user", content: "close out the release" }];

const readRuns: ToolDefinition = {
  name: "list_runs",
  description: "list runs",
  parametersJsonSchema: { type: "object", properties: {} },
  isReadOnly: true,
  call: async () => ({ content: "two runs", isError: false }),
};

const shipRelease: ToolDefinition = {
  name: "ship_release",
  description: "mark a release shipped",
  parametersJsonSchema: { type: "object", properties: { id: { type: "string" } } },
  call: async () => ({ content: "shipped", isError: false }),
};

const envelope = {
  id: "env-1",
  goal: "summarise the runs",
  budgets: { timeSec: 600 },
  stop: { onBudgetExhausted: "halt_checkpoint" as const },
  escalation: { onScopeExceeded: "refuse_and_replan" as const },
  rollbackRequired: false,
  // Reads granted, writes empty: the task may look and may not act.
  scope: { reads: ["list_runs"], writes: [], forbidden: [] },
};

describeTrust("TRUST-134 — the loop refuses out of scope and asks about declared effects, mid-run", () => {
  it("refuses the out-of-scope call, executes the in-scope one beside it, and the RUN CONTINUES", async () => {
    let shipped = 0;
    const ship: ToolDefinition = {
      ...shipRelease,
      call: async () => {
        shipped += 1;
        return { content: "shipped", isError: false };
      },
    };
    const { transport, requests } = fakeTransport([
      // One batch, two calls: the granted read and the ungranted write.
      calls([
        { id: "c1", name: "list_runs", args: "{}" },
        { id: "c2", name: "ship_release", args: '{"id":"rel-9"}' },
      ]),
      text("I could not ship — that is outside this task's scope. Here is the summary instead."),
    ]);
    const result = await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([readRuns, ship]),
      envelope,
    });
    // The write never ran. Not "ran and was logged" — the boundary is enforced before the tool is invoked.
    expect(shipped).toBe(0);
    // The refusal is DELIVERED to the model as that call's result, in the same turn, so the agent can act on
    // it. A refusal the agent cannot see is indistinguishable from a tool that silently did nothing.
    const toolMessages = (requests[1]?.messages ?? []).filter((m) => m.role === "tool");
    const refusal = toolMessages.find((m) => typeof m.content === "string" && m.content.includes("out_of_scope"));
    expect(refusal).toBeDefined();
    // …and the sibling call in the same batch was still executed: one refused capability is not a poisoned turn.
    expect(toolMessages.some((m) => typeof m.content === "string" && m.content.includes("two runs"))).toBe(true);
    // The run reached its own end rather than being killed by the boundary.
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toContain("outside this task's scope");
  });

  it("a benign-named READ tool that declares external, non-idempotent effects still asks", async () => {
    // `summarize_for_partner` reads. It also ships the text to somebody else's server, which its author
    // declared. Reads are the agent's senses and stay ungated; a read that leaves the building is not one.
    const asked: PermissionRequest[] = [];
    const exfiltrating: ToolDefinition = {
      name: "summarize_for_partner",
      description: "summarise the run and post it to the partner's endpoint",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: true,
      // Reads the workspace, and what it reads LEAVES the workspace. `sideEffect: none` is a true statement
      // about the wrong axis — the one that decides here is `dataAccess.egress` (consent reason ④).
      effects: {
        sideEffect: "none" as const,
        dataAccess: { reads: "workspace" as const, egress: "external" as const },
      },
      call: async () => ({ content: "sent", isError: false }),
    };
    const { transport } = fakeTransport([
      calls([{ id: "c1", name: "summarize_for_partner", args: "{}" }]),
      text("done"),
    ]);
    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([exfiltrating]),
      // Auto mode: the host approves what it is asked about. What is certified here is that it was ASKED —
      // the decision to prompt comes from the declaration, not from the tool's read-only flag.
      permit: async (request) => {
        asked.push(request);
        return "allow" as const;
      },
    });
    expect(asked.map((r) => r.name)).toEqual(["summarize_for_partner"]);
    // The host classifies risk from what the author STATED, so the declaration rides along with the request.
    expect(asked[0]?.effects).toEqual({
      sideEffect: "none",
      dataAccess: { reads: "workspace", egress: "external" },
    });
    expect(asked[0]?.isReadOnly).toBe(true);
  });

  it("a plain read is NOT gated — the rule is the declaration, not caution about everything", async () => {
    // The other half, and the reason the first is meaningful: if every read prompted, "it asked" would carry
    // no information about this tool at all.
    const asked: string[] = [];
    const { transport } = fakeTransport([calls([{ id: "c1", name: "list_runs", args: "{}" }]), text("done")]);
    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([readRuns]),
      permit: async (request) => {
        asked.push(request.name);
        return "allow" as const;
      },
    });
    expect(asked).toEqual([]);
  });
});
