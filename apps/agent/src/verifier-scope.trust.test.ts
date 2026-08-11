import { authorizeResourceAccess, authorizeToolInvocation } from "@everdict/contracts";
import type { TaskEnvelope } from "@everdict/contracts";
import { describe, expect, it } from "vitest";

// Trust suite (docs/trust-certification.md) — TRUST-128.
//
// A DECLARED SCOPE SURVIVES THE COMPOSE POINT.
//
// The turn completes an activation's envelope from the resolved toolset — reads "all" (an executor's senses)
// plus every write-capable tool present. That is right for an agent whose scope only exists once its tools
// do, and it was applied UNCONDITIONALLY, which is wrong for the one kind of task whose scope is decided
// before it is spawned.
//
// The consequence, had a verifier runner been bound to that seam: `verifierEnvelopeFor` builds an empty write
// list, evidence-only reads and an object whitelist; the compose point would have replaced all three — reads
// widened to "all", every write tool granted, `resources` dropped entirely — and handed the kernel the result.
// Both guards would then have enforced, faithfully, a boundary nobody meant. The producer is certified
// (TRUST-31) and the kernel is certified (TRUST-14); the step between them was not, and it was the one that
// decided what the other two were talking about.
//
// This is that step: the composition the turn performs, over the envelope a spawn site actually builds.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

// The compose rule, verbatim from chat.ts: a DECLARED scope is kept; the executor posture fills an absent one.
const compose = (envelope: Omit<TaskEnvelope, "scope"> & { scope?: TaskEnvelope["scope"] }, writeTools: string[]) => ({
  ...envelope,
  scope: envelope.scope ?? { reads: "all" as const, writes: writeTools, forbidden: [] },
});

const base = {
  id: "env-1",
  goal: "verify checkpoint cp-1",
  budgets: { timeSec: 600 },
  stop: { onBudgetExhausted: "halt_checkpoint" as const },
  escalation: { onScopeExceeded: "refuse_and_replan" as const },
  rollbackRequired: false,
};

describeTrust("TRUST-128 — a role-bound scope is not 'completed' by the turn", () => {
  const verifier = {
    ...base,
    role: "verifier" as const,
    scope: {
      reads: ["get_scorecard"],
      writes: [],
      forbidden: [],
      resources: [{ type: "scorecard", id: "sc-7" }],
    },
  };

  it("the declared scope reaches the kernel intact — writes stay empty, reads stay narrow", () => {
    const composed = compose(verifier, ["submit_scorecard", "write_file"]) as TaskEnvelope;
    expect(composed.scope.writes).toEqual([]);
    expect(composed.scope.reads).not.toBe("all");
    expect(authorizeToolInvocation({ name: "submit_scorecard" }, composed)).toMatchObject({ allowed: false });
    expect(authorizeToolInvocation({ name: "list_datasets", isReadOnly: true }, composed)).toMatchObject({
      allowed: false,
    });
  });

  it("…and the OBJECT whitelist survives — dropping `resources` would silently unbound the evidence", () => {
    const composed = compose(verifier, ["write_file"]) as TaskEnvelope;
    expect(authorizeResourceAccess({ type: "scorecard", id: "sc-7" }, composed)).toMatchObject({ allowed: true });
    expect(authorizeResourceAccess({ type: "scorecard", id: "sc-8" }, composed)).toMatchObject({ allowed: false });
  });

  it("an activation with NO declared scope still gets the executor posture — the default is not removed", () => {
    // The ordinary case must keep working: an agent whose scope only exists once its tools do.
    const composed = compose(base, ["write_file"]) as TaskEnvelope;
    expect(composed.scope.reads).toBe("all");
    expect(authorizeToolInvocation({ name: "write_file" }, composed)).toMatchObject({ allowed: true });
    expect(composed.scope.resources).toBeUndefined();
  });
});
