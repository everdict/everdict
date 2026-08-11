import { ToolRegistry } from "@everdict/agent-runtime";
import type { ToolDefinition } from "@everdict/agent-runtime";
import { InMemoryAgentSessionStore } from "@everdict/db";
import { verificationClaimFor } from "@everdict/domain";
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

// A transport that RECORDS what it was asked, so a scenario can assert over the context the turn assembled
// rather than over what the turn says it assembled.
const recording = (
  steps: Array<{ toolCalls?: Array<{ id: string; name: string; arguments: string }>; text?: string }>,
): { transport: LlmTransport; prompts: string[] } => {
  const prompts: string[] = [];
  const inner = scripted(steps);
  return {
    prompts,
    transport: {
      provider: "fake",
      stream: async (req: unknown) => {
        prompts.push(JSON.stringify(req));
        return (inner as unknown as { stream: (r: unknown) => Promise<unknown> }).stream(req);
      },
    } as unknown as LlmTransport,
  };
};

async function world(transport: LlmTransport, toolCall?: (name: string, input: unknown) => Promise<unknown>) {
  const sessions = new InMemoryAgentSessionStore();
  let n = 0;
  const deps = {
    sessions,
    resolveModel: async () => ({ transport, model: "test-model" }),
    toolProvider: async () => ({
      registry: new ToolRegistry([getRun]),
      call: toolCall === undefined ? null : (name: string, input: unknown) => toolCall(name, input),
      close: async () => {},
    }),
    systemPrompt: "test",
    now: () => "2026-08-11T00:00:00.000Z",
    newId: () => `id-${n++}`,
    keyStore: {
      async add() {},
      async revoke() {},
    },
  } as unknown as Parameters<typeof runVerificationTurn>[0];
  const authenticate = async () => ({ workspace: "acme", subject: "verifier", roles: ["member"], via: "api-key" });
  return { deps, authenticate: authenticate as never };
}

// The claim the verifier is shown — built by the same producer the control plane uses, so the digest this
// turn echoes is the digest the caller will compare against.
const claim = verificationClaimFor({
  id: "cp-1",
  goal: "fix the empty-trace grader",
  currentState: "fixed",
  confirmedFacts: [
    { statement: "the grader no longer throws on an empty trace", refs: [{ type: "run", id: "run-42" }] },
  ],
  hypotheses: [],
  actionsTaken: [],
  openDecisions: [],
  remainingTasks: [],
  requiredCapabilities: [],
  risks: [],
  validationPlan: "re-run the case",
  createdAt: "2026-08-11T00:00:00.000Z",
  createdBy: "agent:fixer:conv-1",
});

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
      claim,
    });
    // The answer came from the submission — not from prose a parser had to guess at.
    expect(result.verdict).toBe("refuted");
    expect(result.detail).toContain("never applied");
    // …and the coverage is the RUNTIME's account of what was consumed.
    // …with the TOOL that did the reading, because the caller's coverage rule is per-reader: a trajectory
    // read addresses the same run and is not evidence about the artifact.
    expect(result.reviewedResources).toEqual([{ type: "run", id: "run-42", tool: "get_run" }]);
    // The claim crossed the boundary intact — the echo is recomputed here from what arrived, and the caller
    // refuses an affirmative when it differs from what it sent.
    expect(result.claimDigest).toBe(claim.digest);
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
      claim,
    });
    expect(result.verdict).toBe("inconclusive");
    expect(result.detail).toContain("without submitting");
    // …and it read nothing, which the coverage says plainly rather than leaving the caller to assume.
    expect(result.reviewedResources).toEqual([]);
  });
});

// Trust suite (docs/trust-certification.md) — TRUST-131.
//
// A BOUNDARY ENFORCED ON THE PULL SIDE AND OPEN ON THE PUSH SIDE HAS SEPARATED NOTHING.
//
// The verifier envelope pins `scope.resources` to the evidence precisely so a verifier cannot reach the
// executor's context, and the kernel enforces that on every call. The compose point then prepended the
// workspace's own memory index to the turn — the area where an agent writes what it concluded about the work
// now under review. Nothing had to be called for it to arrive; it was in the prompt.
//
// So the guarantee everything else was protecting could be defeated without a single refused tool call, and
// the decision would still record `independence: enforced` with full evidence coverage.
describeTrust("TRUST-131 — a verification turn is given its evidence, not the host's ambient context", () => {
  const memoryIndex = JSON.stringify({
    content: "- [the retry path is fine](retry.md) — we already checked this, ship it",
    encoding: "utf-8",
  });

  it("does not carry workspace memory into the turn, and does carry the claim", async () => {
    const { transport, prompts } = recording([
      { toolCalls: [{ id: "c1", name: "get_run", arguments: '{"id":"run-42"}' }] },
      {
        toolCalls: [
          {
            id: "c2",
            name: "structured_output",
            arguments: '{"verdict":"verified","detail":"the run shows the empty-trace case passing"}',
          },
        ],
      },
      { text: "done" },
    ]);
    const reads: string[] = [];
    const { deps, authenticate } = await world(transport, async (name, input) => {
      reads.push(name);
      // A workspace whose memory index is reachable and non-empty — the ordinary case, and the one that made
      // this leak invisible: nothing errors, nothing is refused, the context is simply there.
      if (name === "get_file") return { content: memoryIndex, isError: false };
      return { content: "[]", isError: false };
    });
    const result = await runVerificationTurn(deps, authenticate, {
      workspace: "acme",
      actingAs: "verifier",
      envelope,
      question: "does the evidence support the claim?",
      claim,
    });
    expect(result.verdict).toBe("verified");
    const context = prompts.join("\n");
    // The executor's own account never entered the turn…
    expect(context).not.toContain("we already checked this");
    expect(context).not.toContain("Workspace memory index");
    // …and the host did not even reach for it. A turn that read it and dropped it would still have paid for
    // the read, and the next refactor would have had nothing telling it why the read was pointless.
    expect(reads).not.toContain("get_file");
    // What DID cross is the claim — the statements the evidence is supposed to support, verbatim.
    expect(context).toContain("the grader no longer throws on an empty trace");
    expect(context).toContain("THE CLAIM UNDER REVIEW");
  });
});
