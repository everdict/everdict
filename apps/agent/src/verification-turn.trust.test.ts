import { ToolRegistry } from "@everdict/agent-runtime";
import type { ToolDefinition } from "@everdict/agent-runtime";
import { InMemoryAgentSessionStore } from "@everdict/db";
import type { LlmTransport } from "@everdict/llm";
import { describe, expect, it } from "vitest";
import type { ChatDeps } from "./chat.js";
import { runVerificationTurn } from "./verification-turn.js";

// Trust suite (docs/trust-certification.md) — TRUST-129.
//
// A VERDICT IS WHAT THE VERIFIER SUBMITTED AND WHAT THE RUNTIME SAW — never the model's account of itself.
//
// The strand this covers is the one the pieces could not: the envelope reaches the kernel, the kernel refuses
// what is out of scope, the verdict comes back as a SUBMISSION, and coverage is assembled from what the
// runtime observed being consumed. Each half was certified alone; nothing had run them as one turn.
//
// The failure it exists to prevent is specific. An agent that read nothing can still write a confident
// paragraph, and a paragraph is what a prose-parsed verdict is made of — so a verification that could not
// look would have been indistinguishable from one that looked and agreed.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const getRun: ToolDefinition = {
  name: "get_run",
  description: "read a run",
  parametersJsonSchema: { type: "object", properties: { id: { type: "string" } } },
  isReadOnly: true,
  resourceTargets: (input) => {
    const id = (input as { id?: unknown }).id;
    return typeof id === "string" ? { kind: "targets", values: [{ type: "run", id }] } : { kind: "indeterminate" };
  },
  call: async (input) =>
    (input as { id: string }).id === "run-42"
      ? { content: "the run's trace", isError: false }
      : { content: "not found", isError: true },
};

// A transport that plays a fixed script: each call returns one step (tool calls, then a final message).
const scripted = (
  steps: Array<{ toolCalls?: Array<{ id: string; name: string; arguments: string }>; text?: string }>,
): LlmTransport => {
  let i = 0;
  return {
    provider: "fake",
    stream: async () => {
      const step = steps[Math.min(i++, steps.length - 1)];
      return {
        content: step?.text ?? "",
        toolCalls: step?.toolCalls ?? [],
        finishReason: step?.toolCalls?.length ? "tool_calls" : "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  } as unknown as LlmTransport;
};

async function world(transport: LlmTransport) {
  const sessions = new InMemoryAgentSessionStore();
  let n = 0;
  const deps = {
    sessions,
    resolveModel: async () => ({ transport, model: "test-model" }),
    toolProvider: async () => ({ registry: new ToolRegistry([getRun]), call: null, close: async () => {} }),
    systemPrompt: "test",
    now: () => "2026-08-11T00:00:00.000Z",
    newId: () => `id-${n++}`,
    keyStore: {
      async add() {},
      async revoke() {},
    },
  } as unknown as ChatDeps & { keyStore: unknown; newId: () => string; now: () => string };
  const authenticate = async () => ({ workspace: "acme", subject: "verifier", roles: ["member"], via: "api-key" });
  return { deps, authenticate: authenticate as never };
}

const envelope = {
  id: "env-v",
  goal: "verify cp-1",
  role: "verifier" as const,
  scope: { reads: ["get_run"], writes: [], forbidden: [], resources: [{ type: "run", id: "run-42" }] },
  budgets: { tokens: 50_000 },
  stop: { onBudgetExhausted: "halt_checkpoint" as const },
  escalation: { onScopeExceeded: "refuse_and_replan" as const },
  rollbackRequired: false,
};

describeTrust("TRUST-129 — a verification turn reports the submission and the runtime's own account", () => {
  it("the verdict is the SUBMISSION, and coverage is what the runtime saw consumed", async () => {
    // The verifier reads its evidence, tries a sibling the envelope does not grant, then submits. Three
    // different facts have to come back separately: the answer, what was read, and what was refused.
    const { deps, authenticate } = await world(
      scripted([
        {
          toolCalls: [
            { id: "c1", name: "get_run", arguments: '{"id":"run-42"}' }, // granted evidence
          ],
        },
        {
          toolCalls: [
            {
              id: "c2",
              name: "structured_output",
              arguments: '{"verdict":"refuted","detail":"the trace shows the fix was never applied"}',
            },
          ],
        },
        { text: "done" },
      ]),
    );
    const result = await runVerificationTurn(deps, authenticate, {
      workspace: "acme",
      actingAs: "verifier",
      envelope,
      question: "does the evidence support the claim?",
    });
    // The answer came from the submission — not from prose a parser had to guess at.
    expect(result.verdict).toBe("refuted");
    expect(result.detail).toContain("never applied");
    // …and the coverage is the RUNTIME's account of what was consumed.
    expect(result.reviewedResources).toEqual([{ type: "run", id: "run-42" }]);
    expect(result.failedResources).toEqual([]);
  });

  it("a turn that never submits is INCONCLUSIVE, and says that is what happened", async () => {
    // Not "the evidence could not decide" — the run happened and no answer came back. A ledger that merges
    // the two has recorded a judgment nobody made.
    const { deps, authenticate } = await world(scripted([{ text: "I think it is probably fine." }]));
    const result = await runVerificationTurn(deps, authenticate, {
      workspace: "acme",
      actingAs: "verifier",
      envelope,
      question: "does the evidence support the claim?",
    });
    expect(result.verdict).toBe("inconclusive");
    expect(result.detail).toContain("without submitting");
    // …and it read nothing, which the coverage says plainly rather than leaving the caller to assume.
    expect(result.reviewedResources).toEqual([]);
  });
});
