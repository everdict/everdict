import {
  type ActorRef,
  type HandoffCheckpoint,
  HandoffCheckpointSchema,
  type RoleAssignment,
  type RoleProfile,
  type TaskEnvelope,
  TaskEnvelopeSchema,
} from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  assertCheckpointForEnvelope,
  assertEnvelopeForRole,
  assertIndependentVerification,
  assertRoleProfile,
  assertTaskEnvelope,
  authorizeToolInvocation,
  budgetExhausted,
  danglingCheckpointRefs,
} from "./ownership.js";

// The ownership kernel's acceptance queries (digo-edu B2/B5/B6 battery) pinned as invariants.

const envelope = (over: Partial<TaskEnvelope> = {}): TaskEnvelope => ({
  id: "env-1",
  goal: "fix the failing grader",
  scope: { reads: "all", writes: ["edit_file", "run_tests"], forbidden: ["deploy"] },
  budgets: { tokens: 100_000 },
  stop: { onBudgetExhausted: "halt_checkpoint" },
  escalation: { onScopeExceeded: "refuse_and_replan" },
  rollbackRequired: false,
  ...over,
});

describe("O2 — role separation invariants", () => {
  it("a verifier/observer that can write is refused — an actor never finally judges its own work", () => {
    expect(() =>
      assertRoleProfile({
        role: "verifier",
        capabilities: { read: ["scorecards"], write: ["edit_file"] },
        requiredEvidence: ["scorecard"],
        completion: "verified_verdict",
      }),
    ).toThrow(/read-only/);
  });

  it("only the verifier completes with a verified verdict — an executor finishing is a claim", () => {
    expect(() =>
      assertRoleProfile({
        role: "executor",
        capabilities: { read: [], write: ["edit_file"] },
        requiredEvidence: ["diff"],
        completion: "verified_verdict",
      }),
    ).toThrow(/claim, not a verdict/);
  });
});

describe("O3 — a verdict needs an independent actor, not just a second role", () => {
  const executorOf = (actor: ActorRef): RoleAssignment => ({
    profile: {
      role: "executor",
      capabilities: { read: ["read_file"], write: ["edit_file"] },
      requiredEvidence: ["diff"],
      completion: "change_set",
    },
    actor,
  });
  const verifierOf = (actor: ActorRef): RoleAssignment => ({
    profile: {
      role: "verifier",
      capabilities: { read: ["scorecards"], write: [] },
      requiredEvidence: ["scorecard"],
      completion: "verified_verdict",
    },
    actor,
  });

  it("the actor that did the work cannot verify it — swapping roles is not swapping actors", () => {
    // Given one actor holding both assignments (every intra-profile rule satisfied) …
    const both = { id: "agent:fixer" };
    expect(() => assertRoleProfile(executorOf(both).profile)).not.toThrow();
    expect(() => assertRoleProfile(verifierOf(both).profile)).not.toThrow();
    // When it verifies its own work / Then the verdict is refused.
    expect(() => assertIndependentVerification(executorOf(both), verifierOf(both))).toThrow(/cannot verify its own/);
  });

  it("a different actor verifying is accepted", () => {
    expect(() =>
      assertIndependentVerification(executorOf({ id: "agent:fixer" }), verifierOf({ id: "agent:checker" })),
    ).not.toThrow();
  });

  it("two identities sharing one run or session are not independent — the context came with them", () => {
    expect(() =>
      assertIndependentVerification(
        executorOf({ id: "agent:fixer", runId: "run-42" }),
        verifierOf({ id: "agent:checker", runId: "run-42" }),
      ),
    ).toThrow(/not independent/);
    expect(() =>
      assertIndependentVerification(
        executorOf({ id: "agent:fixer", sessionId: "conv-1" }),
        verifierOf({ id: "agent:checker", sessionId: "conv-1" }),
      ),
    ).toThrow(/inherits its reasoning/);
    // Different runs, same two actors — independent.
    expect(() =>
      assertIndependentVerification(
        executorOf({ id: "agent:fixer", runId: "run-42" }),
        verifierOf({ id: "agent:checker", runId: "run-43" }),
      ),
    ).not.toThrow();
  });

  it("abstains when no verdict is being claimed — a change_set claims nothing about someone else's work", () => {
    const same = { id: "agent:fixer" };
    const reporter: RoleAssignment = {
      profile: {
        role: "diagnostician",
        capabilities: { read: ["read_file"], write: [] },
        requiredEvidence: ["report"],
        completion: "report",
      },
      actor: same,
    };
    expect(() => assertIndependentVerification(executorOf(same), reporter)).not.toThrow();
  });
});

describe("O5 — the envelope is a decision boundary", () => {
  it("scope-exceeding returns refuse_and_replan — proceeding anyway is not in the vocabulary", () => {
    const decision = authorizeToolInvocation({ name: "run_migration", isReadOnly: false }, envelope());
    expect(decision).toEqual({ allowed: false, reason: "out_of_scope", action: "refuse_and_replan" });
  });

  it("forbidden beats every grant — deny precedence for reads AND writes", () => {
    const e = envelope({ scope: { reads: "all", writes: ["deploy", "edit_file"], forbidden: ["deploy"] } });
    expect(authorizeToolInvocation({ name: "deploy", isReadOnly: false }, e)).toMatchObject({
      allowed: false,
      reason: "forbidden",
    });
    expect(authorizeToolInvocation({ name: "deploy", isReadOnly: true }, e)).toMatchObject({
      allowed: false,
      reason: "forbidden",
    });
    expect(authorizeToolInvocation({ name: "edit_file", isReadOnly: false }, e)).toEqual({ allowed: true });
  });

  it("reads mean what they say — an explicit reads list refuses a read tool outside it", () => {
    // Regression: the previous single-list scope was enforced for writes only, so an evidence-only read
    // scope (verifier/diagnostician posture) was a type-level claim the runtime never honored.
    const e = envelope({ scope: { reads: ["list_runs"], writes: [], forbidden: [] } });
    expect(authorizeToolInvocation({ name: "list_runs", isReadOnly: true }, e)).toEqual({ allowed: true });
    expect(authorizeToolInvocation({ name: "read_secrets", isReadOnly: true }, e)).toMatchObject({
      allowed: false,
      reason: "out_of_scope",
    });
    // A tool with NO isReadOnly declaration gets the stricter (write) gate — unknown effects never ride the senses.
    expect(authorizeToolInvocation({ name: "mystery_tool" }, e)).toMatchObject({
      allowed: false,
      reason: "out_of_scope",
    });
  });

  it("the legacy single-list scope still parses — reads 'all', the old list becomes writes", () => {
    // In-flight payloads written before the split keep validating; the transform states exactly what the
    // runtime enforced for them all along (writes gated, reads open).
    const parsed = TaskEnvelopeSchema.parse({
      id: "env-legacy",
      goal: "old shape",
      scope: { allowedCapabilities: ["edit_file"], forbidden: ["deploy"] },
      budgets: { tokens: 10 },
      stop: { onBudgetExhausted: "halt_checkpoint" },
      escalation: { onScopeExceeded: "refuse_and_replan" },
      rollbackRequired: false,
    });
    expect(parsed.scope).toEqual({ reads: "all", writes: ["edit_file"], forbidden: ["deploy"] });
  });

  it("an envelope that may read nothing and write nothing is refused — it is not a task", () => {
    expect(
      TaskEnvelopeSchema.safeParse({
        id: "env-empty",
        goal: "nothing",
        scope: { reads: [], writes: [], forbidden: [] },
        budgets: { tokens: 10 },
        stop: { onBudgetExhausted: "halt_checkpoint" },
        escalation: { onScopeExceeded: "refuse_and_replan" },
        rollbackRequired: false,
      }).success,
    ).toBe(false);
  });

  it("budget exhaustion halts WITH a checkpoint — dying silently is the failure the envelope prevents", () => {
    expect(budgetExhausted(envelope(), { tokens: 100_000 })).toEqual({
      exhausted: true,
      budget: "tokens",
      action: "halt_checkpoint",
    });
    expect(budgetExhausted(envelope(), { tokens: 99_999 })).toEqual({ exhausted: false });
  });

  it("an envelope with no hard budget is refused — unbounded autonomy has no decision boundary", () => {
    expect(() => assertTaskEnvelope(envelope({ budgets: {} }))).toThrow(/at least one hard budget/);
  });
});

describe("O2×O5 — a role's capabilities are the ceiling an envelope delegates under", () => {
  const profile = (over: Partial<RoleProfile> = {}): RoleProfile => ({
    role: "verifier",
    capabilities: { read: ["list_runs", "get_scorecard"], write: [] },
    requiredEvidence: [],
    completion: "verified_verdict",
    ...over,
  });

  it("a verifier envelope that delegates writes is refused — an envelope is a subset, never an escalation", () => {
    // The type-level hole this closes: role "verifier" + scope.writes ["deploy_production"] typechecked and
    // the runtime would have enforced exactly what the envelope said — nothing tied scope to role.
    expect(() =>
      assertEnvelopeForRole(
        profile(),
        envelope({ role: "verifier", scope: { reads: ["list_runs"], writes: ["deploy_production"], forbidden: [] } }),
      ),
    ).toThrow(/never an escalation/);
  });

  it('an explicit-read role cannot delegate "all" — unrestricted is not a subset of a restriction', () => {
    expect(() =>
      assertEnvelopeForRole(
        profile(),
        envelope({ role: "verifier", scope: { reads: "all", writes: [], forbidden: [] } }),
      ),
    ).toThrow(/not a subset of a restriction/);
  });

  it("a subset envelope passes; an unrestricted-read role admits any explicit list", () => {
    expect(() =>
      assertEnvelopeForRole(
        profile(),
        envelope({ role: "verifier", scope: { reads: ["list_runs"], writes: [], forbidden: [] } }),
      ),
    ).not.toThrow();
    expect(() =>
      assertEnvelopeForRole(
        profile({ role: "executor", capabilities: { read: "all", write: ["edit_file"] }, completion: "change_set" }),
        envelope({ role: "executor", scope: { reads: ["anything"], writes: ["edit_file"], forbidden: [] } }),
      ),
    ).not.toThrow();
  });

  it("an envelope bound to a profile of a DIFFERENT role is refused — the declared role is not decoration", () => {
    expect(() =>
      assertEnvelopeForRole(
        profile(),
        envelope({ role: "executor", scope: { reads: ["list_runs"], writes: [], forbidden: [] } }),
      ),
    ).toThrow(/cannot run as a role its envelope did not state/);
  });
});

describe("O6 — the checkpoint is a resumable state transfer", () => {
  const checkpoint = (over: Partial<HandoffCheckpoint> = {}): HandoffCheckpoint => ({
    id: "cp-1",
    goal: "fix the failing grader",
    currentState: "root cause isolated to the retry path; fix drafted, tests not yet run",
    confirmedFacts: [{ statement: "the grader throws on empty traces", refs: [{ type: "run", id: "run-42" }] }],
    hypotheses: [{ statement: "the retry path double-frees the compute", confidence: "medium" }],
    actionsTaken: [{ description: "reproduced on run-42", refs: [{ type: "run", id: "run-42" }] }],
    openDecisions: [],
    remainingTasks: ["run the regression suite"],
    requiredCapabilities: ["run_tests"],
    risks: [],
    validationPlan: "run scorecard sc-7 and compare against baseline sc-6",
    createdAt: "2026-08-07T00:00:00.000Z",
    createdBy: "agent:fixer:conv-1",
    ...over,
  });

  it("a 'fact' without an evidence reference cannot exist — the schema itself refuses it", () => {
    const parsed = HandoffCheckpointSchema.safeParse(
      checkpoint({ confirmedFacts: [{ statement: "it is probably the retry path", refs: [] }] }),
    );
    expect(parsed.success).toBe(false); // a statement without evidence IS a hypothesis — say so
  });

  it("dangling references are returned, never silently accepted", async () => {
    const live = new Set(["run-42"]);
    const cp = checkpoint({
      confirmedFacts: [
        { statement: "throws on empty traces", refs: [{ type: "run", id: "run-42" }] },
        { statement: "also seen on the old batch", refs: [{ type: "scorecard", id: "sc-GONE" }] },
      ],
    });
    const dangling = await danglingCheckpointRefs(cp, async (ref) => live.has(ref.id));
    expect(dangling).toEqual([{ ref: { type: "scorecard", id: "sc-GONE" }, where: "confirmedFacts[1]" }]);
  });

  it("an envelope demanding rollback refuses a handoff without a rollback plan", () => {
    const e = envelope({ rollbackRequired: true });
    expect(() => assertCheckpointForEnvelope(checkpoint(), e)).toThrow(/rollback/);
    expect(() =>
      assertCheckpointForEnvelope(checkpoint({ rollbackPlan: "git revert the fix commit; re-run sc-6" }), e),
    ).not.toThrow();
  });
});
