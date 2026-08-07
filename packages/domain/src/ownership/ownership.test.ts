import { type HandoffCheckpoint, HandoffCheckpointSchema, type TaskEnvelope } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  assertCheckpointForEnvelope,
  assertRoleProfile,
  assertTaskEnvelope,
  budgetExhausted,
  danglingCheckpointRefs,
  envelopeAllows,
} from "./ownership.js";

// The ownership kernel's acceptance queries (digo-edu B2/B5/B6 battery) pinned as invariants.

const envelope = (over: Partial<TaskEnvelope> = {}): TaskEnvelope => ({
  id: "env-1",
  goal: "fix the failing grader",
  scope: { allowedCapabilities: ["read_file", "edit_file", "run_tests"], forbidden: ["deploy"] },
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
        contextScopes: [],
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
        contextScopes: [],
        requiredEvidence: ["diff"],
        completion: "verified_verdict",
      }),
    ).toThrow(/claim, not a verdict/);
  });
});

describe("O5 — the envelope is a decision boundary", () => {
  it("scope-exceeding returns refuse_and_replan — proceeding anyway is not in the vocabulary", () => {
    const decision = envelopeAllows(envelope(), "run_migration");
    expect(decision).toEqual({ allowed: false, reason: "out_of_scope", action: "refuse_and_replan" });
  });

  it("forbidden beats allowed — deny precedence when a capability sits on both lists", () => {
    const e = envelope({ scope: { allowedCapabilities: ["deploy", "edit_file"], forbidden: ["deploy"] } });
    expect(envelopeAllows(e, "deploy")).toMatchObject({ allowed: false, reason: "forbidden" });
    expect(envelopeAllows(e, "edit_file")).toEqual({ allowed: true });
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
