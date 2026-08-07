import {
  BadRequestError,
  type CheckpointRef,
  type HandoffCheckpoint,
  type HandoffCheckpointRecord,
  HandoffCheckpointSchema,
  NotFoundError,
  type PlatformFact,
} from "@everdict/contracts";
import { danglingCheckpointRefs } from "@everdict/domain";
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
  // The independence linkage (O3): who created a referenced run. Absent = the check ABSTAINS rather than
  // guessing — an unenforced invariant we can name beats an enforced one we made up.
  runCreator?: (tenant: string, runId: string) => Promise<string | undefined>;
  events?: PlatformEventEmitter;
  newId?: () => string;
  now?: () => string;
}

export interface CreateCheckpointInput {
  tenant: string;
  createdBy: string;
  checkpoint: Omit<HandoffCheckpoint, "id" | "createdAt" | "createdBy">;
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

    await this.persist(input.tenant, record);
    return record;
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
  // in which role, and a referenced run says who created it. A verifier filing a verdict about a run it
  // executed itself is the separation failure the whole protocol exists to catch — and here, uniquely, we can
  // catch it. Every guard is conditional on the linkage being present; a missing piece abstains.
  private async assertNotSelfVerification(tenant: string, checkpoint: HandoffCheckpointRecord): Promise<void> {
    const { runCreator } = this.deps;
    const actor = checkpoint.by;
    if (checkpoint.role !== "verifier" || !actor || !runCreator) return;
    const runIds = new Set(
      [...checkpoint.confirmedFacts.flatMap((f) => f.refs), ...checkpoint.actionsTaken.flatMap((a) => a.refs)]
        .filter((ref) => ref.type === "run")
        .map((ref) => ref.id),
    );
    for (const runId of runIds) {
      if (await this.executedBy(tenant, runId, actor.id, runCreator)) {
        throw new BadRequestError(
          "BAD_REQUEST",
          { runId, actor: actor.id },
          `actor '${actor.id}' cannot file a verifier checkpoint about run '${runId}' — it executed that run, and a verdict from the actor that did the work is a claim wearing a second hat.`,
        );
      }
    }
  }

  private async executedBy(
    tenant: string,
    runId: string,
    actorId: string,
    runCreator: (tenant: string, runId: string) => Promise<string | undefined>,
  ): Promise<boolean> {
    const creator = await runCreator(tenant, runId);
    return creator !== undefined && creator === actorId;
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
