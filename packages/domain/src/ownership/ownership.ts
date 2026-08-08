import {
  BadRequestError,
  type CheckpointRef,
  type HandoffCheckpoint,
  type RoleAssignment,
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

// ── O3: independence — the separation that needs an ACTOR, not just a role ───────────────────────────
// assertRoleProfile above enforces separation WITHIN a profile (a verifier writes nothing; only a verifier
// says "verified"). That is necessary and not sufficient: one process can wear the executor profile and then
// the verifier profile and check its own work, satisfying every intra-profile rule. The verdict is only worth
// something when the actor behind it is a different actor — so the check takes both assignments and compares
// identities, not roles.
//
// ENFORCEMENT BOUNDARY (stated, not implied): this is enforced wherever both identities are actually KNOWN.
// Today that is (a) this function, called by whoever holds both assignments, and (b) the checkpoint service,
// which resolves the referenced run's executor as an ActorRef (id + run + session context) and calls THIS
// function — never a service-local re-implementation of the comparison, which is how the invariant once
// silently narrowed to actor-id equality. Everdict has no verifier RUNTIME yet — no path spawns an agent in
// the verifier role — so there is no third site to bind, and inventing one would be a claim rather than a
// check. Context separation (a verifier gets evidence only, never the executor's reasoning) is a documented
// PRINCIPLE awaiting that runtime; see docs/architecture/ownership-protocol.md.
export function assertIndependentVerification(executor: RoleAssignment, verifier: RoleAssignment): void {
  // Only a verified verdict makes the claim that needs independence — a report or a change_set claims nothing
  // about someone else's work, so there is nothing to separate.
  if (verifier.profile.completion !== "verified_verdict") return;
  if (verifier.actor.id === executor.actor.id) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { actor: verifier.actor.id },
      `actor '${verifier.actor.id}' cannot verify its own work — a verdict from the actor that did the work is a claim wearing a second hat.`,
    );
  }
  // Same run, or same session: different identities that shared one execution context are not independent
  // either — the "verifier" read the executor's own reasoning, which is the thing separation exists to prevent.
  if (executor.actor.runId !== undefined && executor.actor.runId === verifier.actor.runId) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { runId: executor.actor.runId },
      `verification ran inside the executing run '${executor.actor.runId}' — a check sharing the execution it checks is not independent.`,
    );
  }
  if (executor.actor.sessionId !== undefined && executor.actor.sessionId === verifier.actor.sessionId) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { sessionId: executor.actor.sessionId },
      `verification ran inside the executing session '${executor.actor.sessionId}' — a check sharing the executor's context inherits its reasoning.`,
    );
  }
}

// ── O5: the envelope's decisions live IN CONTRACTS beside the schema (the isMeasured precedent) — the
// agent runtime enforces them without a domain dependency. Re-exported here for domain consumers.
export {
  authorizeToolInvocation,
  type BudgetDecision,
  budgetExhausted,
  type EnvelopeDecision,
  type EnvelopeSpend,
} from "@everdict/contracts";

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
