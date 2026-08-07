import {
  BadRequestError,
  type CheckpointRef,
  type HandoffCheckpoint,
  type RoleProfile,
  type TaskEnvelope,
} from "@everdict/contracts";

// The ownership kernel's INVARIANTS (O2/O5/O6) — the rules that make ownership verifiable and transferable.
// Pure guards: a violated invariant throws (an illegal profile/envelope/checkpoint never becomes a record),
// and the decision functions return typed refusals — "proceed anyway" is not in the vocabulary.

// ── O2: role invariants ──────────────────────────────────────────────────────────────────────────────
// Roles whose whole point is that they CHANGE NOTHING — the observer half of "the actor never finally
// judges its own work". A verifier that can write is an actor.
const READ_ONLY_ROLES = new Set<RoleProfile["role"]>(["observer", "diagnostician", "verifier"]);

export function assertRoleProfile(profile: RoleProfile): void {
  if (READ_ONLY_ROLES.has(profile.role) && profile.capabilities.write.length > 0) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { role: profile.role, write: profile.capabilities.write },
      `role '${profile.role}' is read-only by definition — a verifier/observer that can write is an actor, and an actor never finally judges its own work.`,
    );
  }
  // The separation invariant, stated from the other side: only the verifier completes with a verified
  // verdict. An executor's completion is a change_set — a CLAIM someone else verifies.
  if (profile.completion === "verified_verdict" && profile.role !== "verifier") {
    throw new BadRequestError(
      "BAD_REQUEST",
      { role: profile.role },
      `completion 'verified_verdict' belongs to the verifier alone — '${profile.role}' finishing is a claim, not a verdict.`,
    );
  }
}

// ── O5: the envelope's decisions ─────────────────────────────────────────────────────────────────────
export type EnvelopeDecision =
  | { allowed: true }
  // Refusals are DATA the runtime acts on — refuse_and_replan (build a new plan + risk analysis and request
  // approval / hand off), never a soft warning the loop can ignore.
  | { allowed: false; reason: "forbidden" | "out_of_scope"; action: "refuse_and_replan" };

export function envelopeAllows(envelope: TaskEnvelope, capabilityId: string): EnvelopeDecision {
  // Deny precedence: forbidden beats allowed — when a capability appears on both lists, the safer reading wins.
  if (envelope.scope.forbidden.includes(capabilityId))
    return { allowed: false, reason: "forbidden", action: "refuse_and_replan" };
  if (!envelope.scope.allowedCapabilities.includes(capabilityId))
    return { allowed: false, reason: "out_of_scope", action: "refuse_and_replan" };
  return { allowed: true };
}

export interface EnvelopeSpend {
  timeSec?: number;
  tokens?: number;
  usd?: number;
}

export type BudgetDecision =
  | { exhausted: false }
  | { exhausted: true; budget: "timeSec" | "tokens" | "usd"; action: "halt_checkpoint" };

export function budgetExhausted(envelope: TaskEnvelope, spent: EnvelopeSpend): BudgetDecision {
  const b = envelope.budgets;
  if (b.timeSec !== undefined && (spent.timeSec ?? 0) >= b.timeSec)
    return { exhausted: true, budget: "timeSec", action: "halt_checkpoint" };
  if (b.tokens !== undefined && (spent.tokens ?? 0) >= b.tokens)
    return { exhausted: true, budget: "tokens", action: "halt_checkpoint" };
  if (b.usd !== undefined && (spent.usd ?? 0) >= b.usd)
    return { exhausted: true, budget: "usd", action: "halt_checkpoint" };
  return { exhausted: false };
}

export function assertTaskEnvelope(envelope: TaskEnvelope): void {
  const b = envelope.budgets;
  // An unbounded autonomous task has no decision boundary — at least one hard budget, always.
  if (b.timeSec === undefined && b.tokens === undefined && b.usd === undefined) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { id: envelope.id },
      "a task envelope needs at least one hard budget (timeSec | tokens | usd) — an unbounded autonomous task has no decision boundary.",
    );
  }
}

// ── O6: checkpoint invariants ────────────────────────────────────────────────────────────────────────
export interface DanglingRef {
  ref: CheckpointRef;
  where: string; // which checkpoint field carried it
}

// Resolve every reference the checkpoint claims — a fact whose evidence cannot be found is not a fact the
// successor can stand on. `resolve` answers existence per ref (the caller binds it to the real stores);
// dangling refs are RETURNED, never silently accepted, and the caller refuses persistence on any.
export async function danglingCheckpointRefs(
  checkpoint: HandoffCheckpoint,
  resolve: (ref: CheckpointRef) => Promise<boolean>,
): Promise<DanglingRef[]> {
  const out: DanglingRef[] = [];
  const check = async (refs: readonly CheckpointRef[], where: string): Promise<void> => {
    for (const ref of refs) {
      if (!(await resolve(ref))) out.push({ ref, where });
    }
  };
  for (const [i, fact] of checkpoint.confirmedFacts.entries()) await check(fact.refs, `confirmedFacts[${i}]`);
  for (const [i, action] of checkpoint.actionsTaken.entries()) await check(action.refs, `actionsTaken[${i}]`);
  return out;
}

// The envelope↔checkpoint cross-invariant: an envelope that demanded rollback hands off ONLY with a
// rollback plan — the successor must be able to undo the predecessor's work without the predecessor.
export function assertCheckpointForEnvelope(checkpoint: HandoffCheckpoint, envelope: TaskEnvelope): void {
  if (envelope.rollbackRequired && (checkpoint.rollbackPlan === undefined || checkpoint.rollbackPlan === "")) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { checkpoint: checkpoint.id, envelope: envelope.id },
      "this envelope requires rollback — a handoff without a rollback plan strands the successor with changes only the predecessor could undo.",
    );
  }
}
