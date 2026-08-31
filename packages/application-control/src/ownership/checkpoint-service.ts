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
  type EvidenceIdentity,
  PINNABLE_EVIDENCE_KINDS,
  assertCheckpointForEnvelope,
  assertCompletionForRole,
  assertIndependentVerification,
  assertRoleProfile,
  danglingCheckpointRefs,
  verificationClaimFor,
  verifierEnvelopeFor,
  verifierFocus,
  verifierPolicy,
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
  // WHICH VERSION of a piece of evidence is on the table (arch-review 25 P0-3). Existence is not identity: a
  // scorecard's judgments are rewritten in place by a re-score, so a decision that cites only the id records
  // what was LOOKED UP rather than what was SEEN. Bound by the composition root because only it can read the
  // scorecard store; absent = this deployment cannot pin evidence versions, which the decision records as an
  // abstention rather than as a pin nobody made.
  //
  // Returning `undefined` for one ref while answering for others is the third state: a resolver that exists
  // and could not answer. That blocks an affirmative — a verdict about evidence whose version nobody can
  // state cannot be reproduced, and reproducibility is what the pin is for.
  evidencePins?: (
    tenant: string,
    refs: ReadonlyArray<{ type: string; id: string }>,
  ) => Promise<Array<{ type: string; id: string; identity: EvidenceIdentity }>>;
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

// ── O2, CHECKED RATHER THAN INSPECTED (arch-review 124) ──────────────────────────────────────────────
//
// `assertRoleProfile` refuses a read-only role that can write, and a `verified_verdict` completion from
// anyone but the verifier — the half `assertIndependentVerification` calls "necessary and not sufficient".
// It was exported from @everdict/domain and CALLED BY NOTHING, so the separation this service sells had one
// half enforced (actor identity) and one half written down.
//
// It reads as unreachable because no door parses a `RoleProfile`: every profile at runtime is one of the
// three constants above. That is exactly why the check belongs HERE and at module load — the constants are
// the whole population, so checking them is checking every profile that exists, and the day a door does
// accept one, the guard already has a caller to add it to instead of a comment to notice.
for (const profile of [EXECUTOR_ASSIGNMENT_PROFILE, VERIFIER_SPAWN_PROFILE, VERIFIER_ASSIGNMENT_PROFILE])
  assertRoleProfile(profile);

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
    // `focus` is the requester's contribution: WHERE to look. What "verified" means is the platform's
    // (`verifierPolicy`) and no caller supplies it — see the constitution's own comment for what went wrong
    // when this parameter was the whole instruction.
    input: { focus?: string; budgets?: TaskEnvelope["budgets"]; requestedBy?: string } = {},
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
    // WHICH VERSION of each piece of evidence this verdict is about (arch-review 25 P0-3). Resolved BEFORE
    // the verifier runs, so the pin names what was put in front of it rather than what the world looked like
    // when the verdict came back.
    const pinnable = evidence.filter((ref) => PINNABLE_EVIDENCE_KINDS.has(ref.type));
    const pins =
      this.deps.evidencePins && pinnable.length > 0
        ? await this.deps.evidencePins(
            tenant,
            pinnable.map((ref) => ({ type: ref.type, id: ref.id })),
          )
        : undefined;
    // The PLAN's identities — what the readers are pinned to. What the decision records is the OBSERVATION.
    const planned =
      pins === undefined
        ? undefined
        : pinnable.map((ref) => {
            const pin = pins.find((p) => p.type === ref.type && p.id === ref.id);
            // A resolver that ran and could not answer for THIS ref is the third state — named, and blocking.
            if (pin === undefined) return { type: ref.type, id: ref.id, unpinnable: true as const };
            return { type: ref.type, id: ref.id, identity: pin.identity };
          });
    const evidencePins = planned?.filter((entry) => entry.identity !== undefined) ?? [];
    // A RESOLVER WIRED TODAY IS NOT AN INVARIANT OWNED (arch-review 27 P1). `evidencePins` is an optional
    // dependency, and without it `planned` is undefined — no identities, no unpinned entries, and nothing in
    // `gaps` to say so. A deployment that simply forgot to wire the resolver could mint `verified` over
    // evidence whose version nobody recorded, and every artifact around that verdict would look complete.
    //
    // This service is the last authority before "verified" is written down, so it states its own
    // preconditions rather than trusting the composition that happens to be assembled today.
    const unpinnableKinds = pinnable.length > 0 && pins === undefined;

    // THE CLAIM — assembled here, carried there (arch-review 24 P0-3). The question below refers to "the
    // checkpoint's confirmed facts"; until this existed, those facts never left this process, so the verifier
    // was answering about evidence with no assertion attached to it.
    const claim = verificationClaimFor(checkpoint);
    // …AND THE PROCEDURE, which the requester does not get to write (arch-review 25 P0-4).
    const policy = verifierPolicy();
    const focus = verifierFocus(input.focus);
    const verdict = await this.deps.verifier.verify({
      tenant,
      envelope,
      claim,
      policy,
      ...(focus !== undefined ? { focus } : {}),
      ...(evidencePins.length > 0 ? { evidencePins } : {}),
    });

    // WHAT WAS OBSERVED, not what was planned (arch-review 26 P0). The plan resolves an identity before the
    // verifier runs; what the verifier is handed is a LOCATOR, and the reader returns whatever that id
    // resolves to at the moment of the call. A re-score landing in between used to produce a decision naming
    // revision 3 while the model had in fact read revision 4 — every artifact around it consistent, and the
    // sentence it recorded false. The readers now refuse a moved artifact, and the identity filed here is the
    // one the successful read reported.
    const observedByRef = new Map((verdict.observedEvidence ?? []).map((o) => [`${o.type}:${o.id}`, o]));
    const evidenceIdentity = planned?.map((entry) => {
      if (entry.identity === undefined) return { type: entry.type, id: entry.id, unpinnable: true as const };
      const observed = observedByRef.get(`${entry.type}:${entry.id}`);
      // Never opened, or opened and refused as moved: either way this decision cannot state the version the
      // verifier reasoned over, which the gap below turns into a refusal of the affirmative.
      if (observed === undefined || observed.moved === true || observed.identity === undefined)
        return { type: entry.type, id: entry.id, unpinnable: true as const };
      return { type: entry.type, id: entry.id, identity: observed.identity };
    });

    // INDEPENDENCE, applied against EVERY executor in the evidence (arch-review 11). The domain owns the
    // comparison — actor AND run AND session — and this service only assembles the assignments, exactly as
    // the human-filed path does. Checking one executor was a hole the size of the second: a checkpoint citing
    // run-A (agent A) and run-B (agent B), verified by B, compared B against A, passed, and never looked at
    // the work B did itself.
    const coverage = await this.executorsOf(tenant, evidence);
    const executors = coverage.resolved;
    for (const executor of executors) {
      assertIndependentVerification(
        { profile: EXECUTOR_ASSIGNMENT_PROFILE, actor: executor },
        { profile: VERIFIER_ASSIGNMENT_PROFILE, actor: verdict.actor },
      );
    }
    // Independence coverage is THREE states, not two (arch-review 12). `enforced` means every internal run in
    // the evidence resolved to an actor and every one of them was compared. If some did not resolve, what we
    // know is "independent of the ones we could see" — recording that as `enforced` collapses partial
    // knowledge into the optimistic half, which is the same failure the baseline resolution had.
    const independence: "enforced" | "partial" | "abstained" =
      coverage.runRefs === 0
        ? "abstained"
        : coverage.unresolvedRunIds.length === 0
          ? "enforced"
          : executors.length === 0
            ? "abstained"
            : "partial";

    // EVIDENCE coverage: what the RUNTIME saw the verifier read, against what the checkpoint offered.
    // SUCCESSFULLY read, per the runtime's own outcome — not merely addressed (arch-review 13).
    const granted = new Set<string>(this.deps.verifierTools ?? DEFAULT_VERIFIER_TOOLS);
    const readerFor = (ref: CheckpointRef): string | undefined => EVIDENCE_READER_BY_TYPE[ref.type];
    // COVERAGE IS PER-READER, not per-ref-id (arch-review 24 P0-4). Several tools can address one run: the
    // evidence reader returns the run's recorded outcome, the trajectory reader returns the executor's own
    // account of producing it. Only the first is evidence about the artifact — counting the second as
    // coverage certifies "the verifier examined run-42" for a verifier that read the story about run-42, which
    // is the exact context separation the verifier envelope exists to enforce.
    //
    // A read the runtime could not attribute to a tool does not count either: unattributed is unproven, and
    // this is a coverage claim an affirmative verdict rests on.
    const readByDesignatedReader = (
      observed: ReadonlyArray<{ type: string; id: string; tool?: string }>,
      ref: CheckpointRef,
    ): boolean => {
      const reader = readerFor(ref);
      return observed.some((r) => r.type === ref.type && r.id === ref.id && reader !== undefined && r.tool === reader);
    };
    const reviewed = evidence.filter((ref) => readByDesignatedReader(verdict.reviewedResources ?? [], ref));
    const failedReads = evidence.filter((ref) => readByDesignatedReader(verdict.failedResources ?? [], ref));
    const unreachable = evidence.filter((ref) => {
      const reader = readerFor(ref);
      return reader === undefined || !granted.has(reader);
    });
    const unreviewed = evidence.filter((ref) => !reviewed.includes(ref) && !unreachable.includes(ref));

    // "VERIFIED" IS A STRONG WORD, and the platform — not the runner — decides whether this decision earns
    // it. An affirmative needs full independence AND every offered-and-reachable ref actually read; anything
    // less is `inconclusive` with the gap named. This is not rewriting the verifier's answer: the runner
    // reported what it concluded, and the platform reports what that conclusion is worth given what was
    // checked. Merging "it holds" with "I could not tell" is the one thing a trust system must never do, and
    // an unchecked half is a species of could-not-tell.
    const gaps: string[] = [
      ...(independence !== "enforced"
        ? [
            `independence could not be established against ${coverage.unresolvedRunIds.length > 0 ? `run(s) ${coverage.unresolvedRunIds.join(", ")}` : "any executor"}`,
          ]
        : []),
      ...(unreviewed.length > 0
        ? [
            `the verifier never successfully read ${unreviewed.map((r) => `${r.type}:${r.id}`).join(", ")}${
              failedReads.length > 0
                ? ` (reads FAILED for ${failedReads.map((r) => `${r.type}:${r.id}`).join(", ")})`
                : ""
            }`,
          ]
        : []),
      ...(unreachable.length > 0
        ? [`no wired tool can address ${unreachable.map((r) => `${r.type}:${r.id}`).join(", ")}`]
        : []),
    ];
    // A verdict that CARRIES CONSEQUENCE needs the coverage its consequence rests on — and "refuted" is on
    // its way to carrying one (rollback, block, escalation), so the rule is stated now rather than after
    // something starts acting on it (arch-review 15 §16). The asymmetry is deliberate and named:
    //
    //   verified   — every offered-and-reachable ref successfully read, independence fully established
    //   refuted    — at least ONE ref successfully read; a contradiction has to have been seen somewhere
    //   inconclusive — no coverage requirement; it is the verdict for "I could not tell"
    //
    // A refutation from an agent that read nothing is a model's opinion about the question, not a finding
    // about the artifact, and it must not be able to stop a deploy on that basis.
    // …and evidence whose VERSION nobody could state (arch-review 25 P0-3). The verdict may still be filed —
    // it happened — but it cannot be affirmative: nobody reading it later can put the same artifact in front
    // of a second verifier, which is the whole content of "this was verified".
    if (unpinnableKinds)
      gaps.push(
        `this deployment cannot pin the version of ${pinnable.map((r) => `${r.type}:${r.id}`).join(", ")}, so nothing records WHICH artifact the verifier read`,
      );
    // …and the same for the instrument. A verdict whose executor nobody can name is not reproducible either,
    // and `executionProfile` was optional on the port precisely because the runner that reports it is the one
    // wired today.
    if (verdict.executionProfile === undefined)
      gaps.push("the runner did not report which model produced this verdict, so its executor is unknown");
    else if (verdict.executionProfile.closure !== "primary_only")
      gaps.push(
        `the verifier ran with an extended model ladder (${verdict.executionProfile.closure}), so the verdict's authority is not the single platform document it names`,
      );
    const unpinned = (evidenceIdentity ?? []).filter((e) => e.unpinnable === true);
    if (unpinned.length > 0)
      gaps.push(
        `the version of ${unpinned.map((e) => `${e.type}:${e.id}`).join(", ")} that the verifier actually read could not be established, so this verdict cannot be reproduced against the same evidence`,
      );

    // THE CLAIM ECHO. The runner reports the digest of the claim text it actually rendered; if that is missing
    // or different, whatever the verifier answered was about some other statement of the case, and neither
    // direction of a strong verdict may rest on it.
    if (verdict.policyDigest === undefined)
      gaps.push("the runner did not report which verifier policy it applied, so the verdict names no procedure");
    else if (verdict.policyDigest !== policy.digest)
      gaps.push(
        `the verifier decided under a different policy than this platform's (sent ${policy.digest}, applied ${verdict.policyDigest})`,
      );
    const policyHeld = verdict.policyDigest === policy.digest;
    if (verdict.claimDigest === undefined)
      gaps.push("the runner did not report which claim it showed the verifier, so the verdict cannot be tied to one");
    else if (verdict.claimDigest !== claim.digest)
      gaps.push(
        `the verifier was shown a different claim than the one under review (sent ${claim.digest}, rendered ${verdict.claimDigest})`,
      );
    const claimCarried = verdict.claimDigest === claim.digest;
    const affirmable =
      verdict.verdict === "verified"
        ? gaps.length === 0
        : verdict.verdict === "refuted"
          ? reviewed.length > 0 && claimCarried && policyHeld
          : true;
    if (verdict.verdict === "refuted" && reviewed.length === 0)
      gaps.push("a refutation must rest on evidence the verifier actually read, and none was");

    // …and the verdict becomes a RECORD, not a return value. A judgment nobody can look up afterwards
    // cannot be cited, cannot be audited, and cannot be compared against the next one.
    const decision: VerificationDecision = {
      id: this.newId(),
      tenant,
      subject: { type: "checkpoint", id: checkpointId },
      evidence,
      executors,
      verifier: verdict.actor,
      verdict: affirmable ? verdict.verdict : "inconclusive",
      detail: affirmable ? verdict.detail : `${verdict.detail} — recorded as inconclusive: ${gaps.join("; ")}.`,
      independence,
      ...(evidenceIdentity !== undefined ? { evidenceIdentity } : {}),
      ...(verdict.executionProfile !== undefined ? { executionProfile: verdict.executionProfile } : {}),
      policy: {
        version: policy.version,
        digest: policy.digest,
        ...(verdict.policyDigest !== undefined ? { applied: verdict.policyDigest } : {}),
      },
      claim: {
        digest: claim.digest,
        ...(verdict.claimDigest !== undefined ? { echoed: verdict.claimDigest } : {}),
        statements: claim.statements.map((s) => s.statement),
      },
      executorCoverage: { runRefs: coverage.runRefs, unresolvedRunIds: coverage.unresolvedRunIds },
      evidenceCoverage: { offered: evidence.length, reviewed, failed: failedReads, unreachable },
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

  // EVERY actor whose work is under review — resolved from ALL of the evidence's run references, the same
  // against. The unresolved ids come back so the decision can NAME the part of the evidence nobody was
  // abstains rather than inventing an identity to compare against. Deduplicated on the full identity, not on
  // the actor id: the same agent in two different sessions is two contexts, and the independence invariant
  // reads run and session as well as actor.
  private async executorsOf(
    tenant: string,
    evidence: readonly CheckpointRef[],
  ): Promise<{ resolved: ActorRef[]; runRefs: number; unresolvedRunIds: string[] }> {
    const { runActor } = this.deps;
    const runIds = [...new Set(evidence.filter((r) => r.type === "run").map((r) => r.id))];
    if (!runActor) return { resolved: [], runRefs: runIds.length, unresolvedRunIds: [...runIds] };
    const seen = new Set<string>();
    const resolved: ActorRef[] = [];
    const unresolvedRunIds: string[] = [];
    for (const runId of runIds) {
      const actor = await runActor(tenant, runId);
      if (!actor) {
        unresolvedRunIds.push(runId); // NAMED, never skipped — an unchecked run is part of the claim
        continue;
      }
      const key = `${actor.id} ${actor.runId ?? ""} ${actor.sessionId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push(actor);
    }
    return { resolved, runRefs: runIds.length, unresolvedRunIds };
  }
}

// The read tools a spawned verifier may call. Evidence readers only — nothing that reaches the executor's
// trajectory, reasoning or conversation, which is the whole point of the separation. Overridable per
// deployment (`verifierTools`) because tool names are a deployment's vocabulary, not a domain constant.
// `get_run_trajectory` was in this list and must never be: it is the executor's own account of how the work
// was done, which is precisely what the envelope's context separation withholds (arch-review 24 P0-4). Its
// presence in the PRODUCTION default meant the invariant held only in the test that passed its own list.
const DEFAULT_VERIFIER_TOOLS = ["get_run", "get_scorecard", "get_file", "get_issue"] as const;

// WHICH TOOL READS EACH EVIDENCE KIND — the map that decides what a verifier can actually REACH
// (arch-review 12). The previous default set named `get_trace`, which is not a tool the control-plane surface
// exposes (the trajectory reader is `get_run_trajectory`), and `commit` has no reader at all because everdict
// does not host the tenant's git remote. Both facts were invisible: a ref nobody could open was simply never
// opened, and the verdict came back "verified" anyway.
//
// A type with NO entry — or one the deployment did not wire — makes that ref UNREACHABLE, which the decision
// records and which blocks an affirmative. "We could not look at this" is not "this holds".
const EVIDENCE_READER_BY_TYPE: Partial<Record<CheckpointRef["type"], string>> = {
  run: "get_run",
  scorecard: "get_scorecard",
  file: "get_file",
  issue: "get_issue",
  // trace: intentionally ABSENT (arch-review 13). A `trace` ref is an EXTERNAL platform's trace — that is why
  // it has no existence resolver either — so naming `get_run_trajectory` as its reader was wrong twice: the
  // trajectory belongs to a RUN (the extractor addresses `{type:"run"}`), so an envelope granting
  // `trace:r-42` would have had the object gate refuse the very call the reachability table said was
  // possible. Static reachability and runtime addressing must speak one vocabulary, and a `trace` ref is
  // honestly unreachable here.
  // commit: intentionally absent — no first-party tool reads a tenant's git remote.
};

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
