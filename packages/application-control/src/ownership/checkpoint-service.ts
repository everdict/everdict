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
} from "@everdict/contracts";
import {
  assertCheckpointForEnvelope,
  assertCompletionForRole,
  assertIndependentVerification,
  danglingCheckpointRefs,
} from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { HandoffCheckpointStore } from "../ports/handoff-checkpoint-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";

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
