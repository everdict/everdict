import {
  type ActorRef,
  BadRequestError,
  type CheckpointRef,
  type HandoffCheckpoint,
  type HandoffCheckpointRecord,
  HandoffCheckpointSchema,
  NotFoundError,
  type PlatformFact,
  type RoleProfile,
  type TaskEnvelope,
  type VerificationDecision,
} from "@everdict/contracts";
import {
  assertCheckpointForEnvelope,
  assertCompletionForRole,
  assertIndependentVerification,
  danglingCheckpointRefs,
  verifierEnvelopeFor,
} from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { HandoffCheckpointStore } from "../ports/handoff-checkpoint-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { VerificationDecisionStore } from "../ports/verification-decision-store.js";
import type { VerifierRunner } from "../ports/verifier-runner.js";

// Handoff checkpoints (ownership protocol O6 — docs/architecture/ownership-protocol.md). A checkpoint is a
// resumable state transfer: the successor decides its next action from evidence REFERENCES, not from the
// predecessor's prose. Two admission rules make that promise keepable, and both live here rather than in the
// store, because both need to read other people's records:
//
//   1. Dangling evidence is refused. `confirmedFacts[].refs` is what separates a fact from a hypothesis, so a
//      "fact" pointing at a run that does not exist is worse than no fact at all — the successor stands on it.
//   2. A verifier does not check its own work. If the checkpoint claims the verifier role and the referenced
//      run was created by the same actor, the verdict is self-verification and the checkpoint is refused.

// Existence resolvers, one per REF TYPE the platform can actually resolve, bound by the composition root.
// A ref type with NO resolver is unverifiable — not false: everdict does not host the tenant's git remote, so
// refusing a checkpoint for citing a commit would be pretending to a check we never performed. What we can
// resolve, we resolve; what we cannot, the record carries as the unverified pointer it is.
export type CheckpointRefResolvers = Partial<
  Record<CheckpointRef["type"], (tenant: string, id: string) => Promise<boolean>>
>;

export interface CheckpointServiceDeps {
  store: HandoffCheckpointStore;
  resolvers: CheckpointRefResolvers;
  // The independence linkage (O3): the ACTOR a referenced run executed as — id plus the run/session context
  // it ran in, so the domain's full independence invariant (actor AND run AND session) can be applied, not a
  // service-local weaker copy of it. Absent = the check ABSTAINS rather than guessing — an unenforced
  // invariant we can name beats an enforced one we made up.
  runActor?: (tenant: string, runId: string) => Promise<ActorRef | undefined>;
  events?: PlatformEventEmitter;
  // Spawns an agent IN THE VERIFIER ROLE (the protocol's third enforcement site). Absent = verification stays
  // a human act, which is the honest state for a deployment that has not wired one — never a silent auto-pass.
  verifier?: VerifierRunner;
  // Where a spawned verifier's verdict becomes a DURABLE, citable decision (arch-review 10 P1). Absent = the
  // decision is returned but not filed — honest for a deployment with no ledger, and the reason the field is
  // optional rather than the service pretending it persisted something.
  verifications?: VerificationDecisionStore;
  // The read TOOLS a verifier envelope grants (the capability half; the resource half is always the
  // evidence). Tool names are a deployment's vocabulary, so this is injectable — absent falls back to the
  // evidence-reader defaults below.
  verifierTools?: readonly string[];
  newId?: () => string;
  now?: () => string;
}

// Synthesized assignments for the independence decision. The checkpoint names a role, not a full profile —
// these carry exactly what assertIndependentVerification keys on (the verifier's completion claim), so the
// DOMAIN function decides and this service only assembles its inputs. Re-implementing the comparison here is
// how the actor/run/session invariant silently drifted to an actor-id-only check once already.
const EXECUTOR_ASSIGNMENT_PROFILE: RoleProfile = {
  role: "executor",
  capabilities: { read: [], write: [] },
  requiredEvidence: [],
  completion: "change_set",
};
// The profile a SPAWNED verifier runs as. `read: "all"` is the CEILING, not the scope — the envelope built
// from it narrows reads to the evidence, and a ceiling that is already narrow would only refuse evidence the
// caller legitimately has. Writes stay empty: the role validator refuses a writing verifier, and the runtime
// scope must agree or the invariant is only a document.
const VERIFIER_SPAWN_PROFILE: RoleProfile = {
  role: "verifier",
  capabilities: { read: "all", write: [] },
  requiredEvidence: [],
  completion: "verified_verdict",
};

const VERIFIER_ASSIGNMENT_PROFILE: RoleProfile = {
  role: "verifier",
  capabilities: { read: [], write: [] },
  requiredEvidence: [],
  completion: "verified_verdict",
};

export interface CreateCheckpointInput {
  tenant: string;
  createdBy: string;
  checkpoint: Omit<HandoffCheckpoint, "id" | "createdAt" | "createdBy">;
  // The policy slice of the envelope this checkpoint suspends. Envelopes are not persisted, so admission can
  // only enforce the envelope↔checkpoint cross-invariant (rollbackRequired ⇒ rollbackPlan) when the producer
  // carries the policy in — and a producer volunteering it can only make the gate STRICTER, never looser
  // (omitting it is exactly today's behavior). The activation's publishHalt sends it.
  envelope?: Pick<TaskEnvelope, "id"> & Partial<Pick<TaskEnvelope, "rollbackRequired">>;
}

export class CheckpointService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: CheckpointServiceDeps) {
    this.newId = deps.newId ?? (() => `cp_${crypto.randomUUID()}`);
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateCheckpointInput): Promise<HandoffCheckpointRecord> {
    const record: HandoffCheckpointRecord = {
      ...HandoffCheckpointSchema.parse({
        ...input.checkpoint,
        id: this.newId(),
        createdAt: this.now(),
        createdBy: input.createdBy,
      }),
      tenant: input.tenant,
    };

    const dangling = await danglingCheckpointRefs(record, (ref) => this.refExists(input.tenant, ref));
    if (dangling.length > 0) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { dangling },
        `this checkpoint cites evidence that does not exist (${dangling
          .map((d) => `${d.where}: ${d.ref.type} '${d.ref.id}'`)
          .join(", ")}) — a fact whose evidence cannot be found is not a fact the successor can stand on.`,
      );
    }
    await this.assertNotSelfVerification(input.tenant, record);
    // The envelope↔checkpoint cross-invariant, enforced exactly where the checkpoint is minted (the domain
    // owns the decision; this service only supplies the inputs the caller carried).
    if (input.envelope) assertCheckpointForEnvelope(record, input.envelope);
    // Completion evidence (O2×O6): a role-claiming checkpoint completes only with the evidence its profile
    // declares. The synthesized profiles declare none yet, so this arms the moment a profile does — the
    // decision exists here, at the one seam holding both the role and the refs, not in a unit test.
    if (record.role === "verifier") assertCompletionForRole(VERIFIER_ASSIGNMENT_PROFILE, record);
    else if (record.role === "executor") assertCompletionForRole(EXECUTOR_ASSIGNMENT_PROFILE, record);

    // Stamp what admission actually CHECKED, per reference — "evidence-backed" and "evidence-VERIFIED" are
    // different claims, and a successor weighing a confirmedFact reads which one it holds. A ref whose type
    // has a resolver survived the dangling gate above, so it is verified; a type with none is carried as the
    // unverified external pointer it is. Unconditional overwrite: a producer-supplied `resolution` is a
    // claim about our own checking, which only the checker gets to make.
    const stampResolution = (ref: CheckpointRef): CheckpointRef => ({
      ...ref,
      resolution: this.deps.resolvers[ref.type] ? "verified" : "unverified_external",
    });
    const stamped: HandoffCheckpointRecord = {
      ...record,
      confirmedFacts: record.confirmedFacts.map((f) => ({ ...f, refs: f.refs.map(stampResolution) })),
      actionsTaken: record.actionsTaken.map((a) => ({ ...a, refs: a.refs.map(stampResolution) })),
    };

    await this.persist(input.tenant, stamped);
    return stamped;
  }

  async get(tenant: string, id: string): Promise<HandoffCheckpointRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `checkpoint '${id}' not found.`);
    return record;
  }

  list(tenant: string, options?: { envelopeId?: string; limit?: number }): Promise<HandoffCheckpointRecord[]> {
    return this.deps.store.list(tenant, options);
  }

  private async refExists(tenant: string, ref: CheckpointRef): Promise<boolean> {
    const resolve = this.deps.resolvers[ref.type];
    if (!resolve) return true; // unverifiable ≠ dangling — see CheckpointRefResolvers
    return resolve(tenant, ref.id);
  }

  // O3 at the one site where both identities are actually knowable: the checkpoint says who produced it and
  // in which role+context, and a referenced run says who executed it and in which context. The DECISION is
  // the domain's (`assertIndependentVerification` — actor AND run AND session independence); this service
  // only assembles the two assignments and executes the answer. The previous shape re-implemented the
  // comparison locally and quietly narrowed the invariant to actor-id equality — a verifier checkpoint filed
  // from inside the executing session by a different agent id sailed through. Every linkage piece is
  // conditional; a missing piece abstains.
  private async assertNotSelfVerification(tenant: string, checkpoint: HandoffCheckpointRecord): Promise<void> {
    const { runActor } = this.deps;
    const actor = checkpoint.by;
    if (checkpoint.role !== "verifier") return;
    // A verifier that declines to say who verified is not independent by construction — `by` is optional on
    // the record (executor checkpoints, plain handoffs), but a VERIFICATION claim without an identity used to
    // make the whole independence check abstain, which is a fail-open on the one field the caller controls.
    if (!actor)
      throw new BadRequestError(
        "BAD_REQUEST",
        { role: checkpoint.role },
        "a verifier checkpoint must declare who verified (`by`) — an anonymous verification cannot claim independence.",
      );
    if (!runActor) return;
    const verifier = { profile: VERIFIER_ASSIGNMENT_PROFILE, actor };
    const runIds = new Set(
      [...checkpoint.confirmedFacts.flatMap((f) => f.refs), ...checkpoint.actionsTaken.flatMap((a) => a.refs)]
        .filter((ref) => ref.type === "run")
        .map((ref) => ref.id),
    );
    for (const runId of runIds) {
      const executorActor = await runActor(tenant, runId);
      if (!executorActor) continue; // linkage missing — abstain, never guess
      assertIndependentVerification({ profile: EXECUTOR_ASSIGNMENT_PROFILE, actor: executorActor }, verifier);
    }
  }

  // Persist state + fact in ONE transaction, then nudge the live consumers. The ONE place a checkpoint becomes
  // durable, so no caller can strand a task without the workspace hearing that it stopped.
  private async persist(tenant: string, record: HandoffCheckpointRecord): Promise<void> {
    const stamped = stampFacts(tenant, [creationFact(record)], { newId: this.newId, now: this.now });
    await this.deps.store.create(
      record,
      stamped.map((s) => s.record),
    );
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
  }

  // Ask a VERIFIER to check an executor's checkpoint (arch-review 9 P2). This is the spawn site
  // `docs/architecture/ownership-protocol.md` said did not exist, and the reason it said the principle was
  // not code. The separations are not this method's to decide: `verifierEnvelopeFor` builds the only envelope
  // a verifier role may run inside (writes empty, reads exactly the evidence), and the agent loop enforces it
  // on every tool call, sub-agents included.
  //
  // The evidence is the checkpoint's OWN refs — what the executor put forward — never the executor's
  // trajectory or reasoning. A verifier that reads how the work was done is reviewing the story; the artifact
  // is the thing under review.
  //
  // The verdict comes back, is CHECKED for independence, and is FILED as a durable VerificationDecision
  // (arch-review 10 P1). The previous shape returned the runner's object straight to the caller: nothing
  // compared the verifier to the executor, nothing was persisted, and the doc beside it claimed both. An
  // agent verifying its own run was refused by exactly nothing. The invariant is not relaxed for agents —
  // it was simply never applied, which is the more embarrassing of the two failures.
  async requestVerification(
    tenant: string,
    checkpointId: string,
    input: { question?: string; budgets?: TaskEnvelope["budgets"]; requestedBy?: string } = {},
  ): Promise<VerificationDecision> {
    if (!this.deps.verifier)
      throw new BadRequestError(
        "BAD_REQUEST",
        { checkpoint: checkpointId },
        "no verifier runtime is configured — verification is a human act in this deployment, and a missing verifier never becomes an automatic pass.",
      );
    const checkpoint = await this.deps.store.get(tenant, checkpointId);
    if (!checkpoint)
      throw new NotFoundError("NOT_FOUND", { checkpoint: checkpointId }, `checkpoint '${checkpointId}' not found.`);
    if (checkpoint.role === "verifier")
      throw new BadRequestError(
        "BAD_REQUEST",
        { checkpoint: checkpointId },
        "this checkpoint is already a verification — verifying a verdict is a second opinion, not the same act.",
      );
    // The artifact under review: every ref the executor put forward as its evidence, deduplicated by
    // (type, id). These are RESOURCES, not capability names — the distinction the envelope now keeps.
    const seen = new Set<string>();
    const evidence: CheckpointRef[] = [];
    for (const ref of [
      ...checkpoint.confirmedFacts.flatMap((f) => f.refs),
      ...checkpoint.actionsTaken.flatMap((a) => a.refs),
    ]) {
      const key = `${ref.type}:${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push(ref);
    }
    if (evidence.length === 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { checkpoint: checkpointId },
        "this checkpoint cites no evidence — there is nothing for a verifier to look at, and a verdict about nothing is not a verdict.",
      );
    const envelopeId = `verify-${checkpointId}`;
    const envelope = verifierEnvelopeFor(VERIFIER_SPAWN_PROFILE, {
      id: envelopeId,
      goal: `verify checkpoint ${checkpointId}`,
      evidence: evidence.map((ref) => ({ type: ref.type, id: ref.id })),
      // The READ TOOLS that reach those objects — the capability half, kept apart from the resource half
      // (arch-review 10 P1). Restricted to evidence readers: no trajectory, no conversation, no workspace
      // browsing. `authorizeResourceAccess` then pins each of these to the evidence above.
      tools: this.deps.verifierTools ?? DEFAULT_VERIFIER_TOOLS,
      // An autonomous task with no hard budget has no decision boundary — the envelope schema says so and
      // this call site is not exempt from it.
      budgets: input.budgets ?? { tokens: 200_000 },
    });
    const verdict = await this.deps.verifier.verify({
      tenant,
      envelope,
      question:
        input.question ??
        `Does this evidence support the checkpoint's confirmed facts? Answer from the evidence alone — you cannot see how the work was done, and that is deliberate.`,
    });

    // INDEPENDENCE, applied to the pair that actually exists (arch-review 10 P1). The domain owns the
    // comparison — actor AND run AND session — and this service only assembles the two assignments, exactly
    // as the human-filed path does. A verdict from an agent that ran inside the executing session is refused
    // here; that shape passed unnoticed while `actor` was a bare string.
    const executor = await this.executorOf(tenant, evidence);
    if (executor !== undefined) {
      assertIndependentVerification(
        { profile: EXECUTOR_ASSIGNMENT_PROFILE, actor: executor },
        { profile: VERIFIER_ASSIGNMENT_PROFILE, actor: verdict.actor },
      );
    }

    // …and the verdict becomes a RECORD, not a return value. A judgment nobody can look up afterwards
    // cannot be cited, cannot be audited, and cannot be compared against the next one.
    const decision: VerificationDecision = {
      id: this.newId(),
      tenant,
      subject: { type: "checkpoint", id: checkpointId },
      evidence,
      ...(executor !== undefined ? { executor } : {}),
      verifier: verdict.actor,
      verdict: verdict.verdict,
      detail: verdict.detail,
      // Which of the two happened, said out loud: an abstention is not a passed check, and a reader weighing
      // this verdict is entitled to know whether independence was proven or merely unopposed.
      independence: executor !== undefined ? "enforced" : "abstained",
      envelopeId,
      createdAt: this.now(),
      createdBy: input.requestedBy ?? "system",
    };
    if (this.deps.verifications) {
      const stamped = stampFacts(tenant, [verificationFact(decision)], { newId: this.newId, now: this.now });
      await this.deps.verifications.create(
        decision,
        stamped.map((s) => s.record),
      );
      if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    }
    return decision;
  }

  // The ACTOR whose work is under review — resolved from the evidence's run references, the same linkage the
  // human-filed path uses. Absent (no run ref, no resolver, an unresolvable run) = the caller abstains
  // rather than inventing an identity to compare against.
  private async executorOf(tenant: string, evidence: readonly CheckpointRef[]): Promise<ActorRef | undefined> {
    const { runActor } = this.deps;
    if (!runActor) return undefined;
    for (const ref of evidence) {
      if (ref.type !== "run") continue;
      const actor = await runActor(tenant, ref.id);
      if (actor) return actor;
    }
    return undefined;
  }
}

// The read tools a spawned verifier may call. Evidence readers only — nothing that reaches the executor's
// trajectory, reasoning or conversation, which is the whole point of the separation. Overridable per
// deployment (`verifierTools`) because tool names are a deployment's vocabulary, not a domain constant.
const DEFAULT_VERIFIER_TOOLS = ["get_run", "get_scorecard", "get_file", "get_issue", "get_trace"] as const;

function verificationFact(decision: VerificationDecision): PlatformFact {
  return {
    kind: "checkpoint.verified",
    subject: { type: "checkpoint", id: decision.subject.id },
    actor: decision.verifier.id,
    payload: {
      decisionId: decision.id,
      verdict: decision.verdict,
      independence: decision.independence,
      evidence: decision.evidence.length,
    },
    // Loop guard #1: an agent-produced verdict stamps its own cause, so a verifier agent never wakes on it.
    ...(decision.verifier.id.startsWith("agent:") ? { causedBy: decision.verifier.id } : {}),
    message: `Verification ${decision.verdict} — checkpoint ${decision.subject.id}`,
  };
}

function creationFact(record: HandoffCheckpointRecord): PlatformFact {
  return {
    kind: "checkpoint.created",
    subject: { type: "checkpoint", id: record.id },
    actor: record.createdBy,
    payload: {
      ...(record.envelopeId !== undefined ? { envelopeId: record.envelopeId } : {}),
      ...(record.role !== undefined ? { role: record.role } : {}),
      remainingTasks: record.remainingTasks.length,
      openDecisions: record.openDecisions.length,
    },
    // Loop guard #1: an agent-authored handoff stamps its own cause, so the agent never wakes on its own halt.
    ...(record.createdBy.startsWith("agent:") ? { causedBy: record.createdBy } : {}),
    message: `Handoff checkpoint published: ${record.goal}`,
  };
}
