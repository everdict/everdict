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

// Narrowed to what it reads so BOTH production envelope authors can call it — the activation composes its
// envelope without a scope (the turn completes it later), and a guard demanding fields it never reads would
// exclude exactly the caller it exists for.
export function assertTaskEnvelope(envelope: Pick<TaskEnvelope, "id" | "budgets">): void {
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

// ── O2×O5: the delegation invariant — a role's capabilities are the CEILING an envelope delegates under ──
// A RoleProfile says what the ROLE may ever touch; a TaskEnvelope says what THIS task actually got. The
// second must be a subset of the first, or the role is decorative: a "verifier" envelope carrying
// `writes: [deploy_production]` typechecks today and the runtime would enforce exactly what it says. The
// verifier RUNTIME (the spawn site that will construct evidence-only envelopes) does not exist yet — this
// function is the decision it MUST call when it does, and until then the envelope authors that declare a
// role are the binding sites.
export function assertEnvelopeForRole(profile: RoleProfile, envelope: TaskEnvelope): void {
  if (envelope.role !== undefined && envelope.role !== profile.role) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { envelope: envelope.id, envelopeRole: envelope.role, profileRole: profile.role },
      `envelope '${envelope.id}' declares role '${envelope.role}' but is being bound to profile '${profile.role}' — a task cannot run as a role its envelope did not state.`,
    );
  }
  const grantedWrites = new Set(profile.capabilities.write);
  const excessWrites = envelope.scope.writes.filter((w) => !grantedWrites.has(w));
  if (excessWrites.length > 0) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { envelope: envelope.id, role: profile.role, writes: excessWrites },
      `envelope '${envelope.id}' delegates write capabilities the '${profile.role}' role does not hold (${excessWrites.join(", ")}) — an envelope is a subset of its role, never an escalation.`,
    );
  }
  const grantedReads = profile.capabilities.read;
  if (envelope.scope.reads === "all") {
    if (grantedReads !== "all") {
      throw new BadRequestError(
        "BAD_REQUEST",
        { envelope: envelope.id, role: profile.role },
        `envelope '${envelope.id}' delegates unrestricted reads but the '${profile.role}' role reads an explicit list — "all" is not a subset of a restriction.`,
      );
    }
    return;
  }
  if (grantedReads === "all") return; // an unrestricted role admits any explicit list
  const readable = new Set(grantedReads);
  const excessReads = envelope.scope.reads.filter((r) => !readable.has(r));
  if (excessReads.length > 0) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { envelope: envelope.id, role: profile.role, reads: excessReads },
      `envelope '${envelope.id}' delegates read capabilities the '${profile.role}' role does not hold (${excessReads.join(", ")}).`,
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

// ── O2×O6: completion evidence is a DECISION, not a declaration ──
// RoleProfile.requiredEvidence stated what a role must leave behind and NOTHING ever read it — "done" stayed
// whatever the finisher claimed. The two vocabularies grew separately (evidence kinds vs CheckpointRef
// types), so the mapping is explicit: trace→a trace ref, scorecard→a scorecard ref, diff→a commit or file
// ref, report→a file ref, and "checkpoint" is satisfied by the checkpoint being filed at all. ALL-OF
// semantics, per the profile's own contract ("the evidence the role MUST leave behind to finish"). The
// production binding site is checkpoint admission (the one seam holding both the role and the refs); the
// synthesized assignment profiles declare no requiredEvidence yet, so the decision arms the moment a real
// profile does — the same decision-ready posture assertEnvelopeForRole ships in.
const EVIDENCE_REF_TYPES: Record<RoleProfile["requiredEvidence"][number], readonly CheckpointRef["type"][]> = {
  trace: ["trace"],
  scorecard: ["scorecard"],
  diff: ["commit", "file"],
  report: ["file"],
  checkpoint: [],
};

export function assertCompletionForRole(profile: RoleProfile, checkpoint: HandoffCheckpoint): void {
  if (profile.requiredEvidence.length === 0) return;
  const present = new Set(
    [...checkpoint.confirmedFacts.flatMap((f) => f.refs), ...checkpoint.actionsTaken.flatMap((a) => a.refs)].map(
      (r) => r.type,
    ),
  );
  const missing = profile.requiredEvidence.filter((kind) => {
    const accepted = EVIDENCE_REF_TYPES[kind];
    return accepted.length > 0 && !accepted.some((t) => present.has(t));
  });
  if (missing.length > 0) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { role: profile.role, missing },
      `role '${profile.role}' completes only with its declared evidence — missing: ${missing.join(", ")}. A completion without the evidence it promised is a claim, not a result.`,
    );
  }
}

// The envelope↔checkpoint cross-invariant: an envelope that demanded rollback hands off ONLY with a
// rollback plan — the successor must be able to undo the predecessor's work without the predecessor.
// Narrowed to what it reads: envelopes are not persisted, so the boundary that enforces this (checkpoint
// admission) receives only the caller-carried policy slice — and a caller volunteering `rollbackRequired`
// can only make the gate stricter, never looser, so the slice is safe to accept from the producer.
export function assertCheckpointForEnvelope(
  checkpoint: HandoffCheckpoint,
  envelope: Pick<TaskEnvelope, "id"> & Partial<Pick<TaskEnvelope, "rollbackRequired">>,
): void {
  if (envelope.rollbackRequired && (checkpoint.rollbackPlan === undefined || checkpoint.rollbackPlan === "")) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { checkpoint: checkpoint.id, envelope: envelope.id },
      "this envelope requires rollback — a handoff without a rollback plan strands the successor with changes only the predecessor could undo.",
    );
  }
}

// The VERIFIER SPAWN's envelope (arch-review 9 P2 — the third enforcement site).
//
// `docs/architecture/ownership-protocol.md` recorded context separation as a PRINCIPLE and said plainly why
// it was not code: "there is no spawn site to bind it to, and writing one so the protocol looks complete
// would be a claim rather than a check". This is that binding. It is deliberately a CONSTRUCTOR, not a
// validator run after the fact: a verifier's envelope is not something a caller proposes and we approve — the
// caller supplies the evidence and the ceiling produces the only envelope that role may run inside.
//
// Two separations, both structural rather than advisory:
//  · CAPABILITY — writes are empty. The role validator already refuses a verifier profile that can write; this
//    makes the RUNTIME scope agree, so `authorizeToolInvocation` refuses every write tool call at the loop.
//  · CONTEXT — reads are exactly the evidence ids, never "all". A verifier that can read the executor's
//    trajectory and reasoning is reviewing the executor's story, not the artifact; that is the failure the
//    separation exists to prevent, and an explicit read list is what makes it unavailable rather than
//    discouraged. Sub-agents inherit the envelope, so a verifier cannot delegate its way out of the ceiling.
//
// Refuses (never returns a weakened envelope): a non-verifier profile, a profile whose ceiling does not
// actually cover the evidence, or an empty evidence set — a verifier with nothing to look at cannot verify.
export function verifierEnvelopeFor(
  profile: RoleProfile,
  input: { id: string; goal: string; evidence: readonly string[]; budgets: TaskEnvelope["budgets"] },
): TaskEnvelope {
  if (profile.role !== "verifier")
    throw new BadRequestError(
      "BAD_REQUEST",
      { role: profile.role },
      `only a verifier profile may be spawned as a verifier — '${profile.role}' judging someone else's work is an actor's claim, not a verdict.`,
    );
  if (input.evidence.length === 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { envelope: input.id },
      "a verifier spawned with no evidence has nothing to verify — an empty read scope is a verdict about nothing.",
    );
  const envelope: TaskEnvelope = {
    id: input.id,
    goal: input.goal,
    role: "verifier",
    // Evidence only. Not "all", not the executor's context — the reason this function exists.
    scope: { reads: [...input.evidence], writes: [], forbidden: [] },
    budgets: input.budgets,
    stop: { onBudgetExhausted: "halt_checkpoint" },
    escalation: { onScopeExceeded: "refuse_and_replan" },
    rollbackRequired: false,
  };
  // The delegation invariant, applied to the envelope this function just built: a role's capabilities are the
  // CEILING. A verifier profile whose read ceiling is an explicit list that does not cover this evidence is a
  // real refusal, not a formality — it means the caller is handing the verifier something it was never
  // profiled to see.
  assertEnvelopeForRole(profile, envelope);
  return envelope;
}
