import { ToolRegistry } from "@everdict/agent-runtime";
import { InMemoryAgentSessionStore, InMemoryTenantKeyStore } from "@everdict/db";
import type { LlmTransport } from "@everdict/llm";
import { describe, expect, it } from "vitest";
import { type AgentServerDeps, buildServer } from "./server.js";

// Trust suite (docs/trust-certification.md) — TRUST-132.
//
// A GUARANTEE THAT IS ONLY A PROPERTY OF THE SENDER IS NOT ENFORCED.
//
// `verifierEnvelopeFor` builds the three separations — writes empty, reads restricted to evidence readers,
// `scope.resources` pinned to the evidence — and TRUST-128 certifies the compose point stops widening them.
// Both live on the CONTROL PLANE side. The agent service then accepted the envelope as `z.record(z.unknown())`
// and cast it into the turn, so every one of those properties held only because the caller happened to hold
// them. Any other caller — a second control plane, a replay, a future headless path, anything that can reach
// an internal endpoint — could hand over `reads: "all"` with no resources and get a run that every layer
// above would still call a verification.
//
// The envelope is a boundary object. This certifies that the boundary it crosses actually reads it.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const idle: LlmTransport = {
  provider: "fake",
  stream: async () => ({
    content: "",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  }),
} as unknown as LlmTransport;

function deps(): AgentServerDeps {
  let n = 0;
  return {
    authenticate: async () => ({ subject: "verifier", workspace: "acme", roles: ["member"] }),
    sessions: new InMemoryAgentSessionStore(),
    keyStore: new InMemoryTenantKeyStore(),
    internalToken: "shhh",
    resolveModel: async () => ({ transport: idle, model: "test-model" }),
    toolProvider: async () => ({ registry: new ToolRegistry([]), call: null, close: async () => {} }),
    systemPrompt: "test",
    now: () => "2026-08-11T00:00:00.000Z",
    newId: () => `id-${n++}`,
  } as unknown as AgentServerDeps;
}

const claim = {
  subject: { type: "checkpoint", id: "cp-1" },
  goal: "fix the empty-trace grader",
  statements: [{ statement: "the grader no longer throws", refs: [{ type: "run", id: "run-42" }] }],
  digest: "sha256:whatever",
};

const verifier = {
  id: "env-v",
  goal: "verify cp-1",
  role: "verifier",
  scope: { reads: ["get_run"], writes: [], forbidden: [], resources: [{ type: "run", id: "run-42" }] },
  budgets: { tokens: 50_000 },
  stop: { onBudgetExhausted: "halt_checkpoint" },
  escalation: { onScopeExceeded: "refuse_and_replan" },
  rollbackRequired: false,
};

async function post(envelope: unknown): Promise<{ status: number; message: string }> {
  const app = buildServer(deps());
  const res = await app.inject({
    method: "POST",
    url: "/internal/verify",
    headers: { "x-internal-token": "shhh" },
    payload: { workspace: "acme", actingAs: "verifier", question: "does it hold?", envelope, claim },
  });
  await app.close();
  return { status: res.statusCode, message: (res.json() as { message?: string }).message ?? "" };
}

describeTrust("TRUST-132 — the verification wire refuses an envelope that is not a verification", () => {
  it("refuses a non-verifier role", async () => {
    const r = await post({ ...verifier, role: "executor" });
    expect(r.status).toBe(400);
    expect(r.message).toContain("not role 'verifier'");
  });

  it("refuses an envelope that can WRITE — a verifier that can write is an actor", async () => {
    const r = await post({ ...verifier, scope: { ...verifier.scope, writes: ["update_issue"] } });
    expect(r.status).toBe(400);
    expect(r.message).toContain("is an actor");
  });

  it("refuses `reads: all` — that is reviewing the executor's context, not its artifact", async () => {
    const r = await post({ ...verifier, scope: { ...verifier.scope, reads: "all" } });
    expect(r.status).toBe(400);
    expect(r.message).toContain("whole workspace");
  });

  it("refuses an envelope with no pinned resources — nothing it is allowed to look at", async () => {
    const r = await post({ ...verifier, scope: { ...verifier.scope, resources: [] } });
    expect(r.status).toBe(400);
    expect(r.message).toContain("nothing it is allowed to look at");
  });

  it("refuses a structurally malformed envelope rather than casting it into the turn", async () => {
    // The pre-fix shape accepted ANY object here. An envelope with no budgets has no decision boundary, and
    // an unbounded autonomous run is the one thing the envelope schema exists to make impossible.
    const { budgets: _dropped, ...noBudget } = verifier;
    const r = await post(noBudget);
    expect(r.status).toBe(400);
  });
});
