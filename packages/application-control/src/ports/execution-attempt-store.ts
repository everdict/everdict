import {
  type ActivationDecision,
  ConflictError,
  EXECUTING_PREDECESSOR_STATES,
  type ExecutionAttemptRecord,
  type ExecutionAttemptState,
  NotFoundError,
  OPEN_RUN_STATUSES,
  OPEN_SCORECARD_STATUSES,
  type PersistedWorkIntent,
  type RuntimeWorkRef,
  attemptIdOf,
  decideActivation,
  isTerminalAttemptState,
} from "@everdict/contracts";

// What an attempt is opened WITH — everything the opener already knows about the execution it is about to
// start. Nothing here is discovered later except `childRunId`, which the batch lanes learn a few lines after
// the open (the child row is created under the coordinate this call mints), so it is patchable on transition.
// WHO an attempt still belongs to, asked at reservation time (arch-review 55, Wave 1). `undefined` means the
// parent is gone or terminal — a cancelled batch, a settled run — and nothing may be placed for it.
export interface AttemptParentAuthority {
  authorityOf(attempt: ExecutionAttemptRecord): Promise<{ epoch: number } | undefined>;
}

export interface OpenAttemptInput {
  executionId: string;
  tenant: string;
  scorecardId?: string;
  caseId?: string;
  trial?: number;
  childRunId?: string;
  driverEpoch?: number;
}

// ── THE PHYSICAL EXECUTION LEDGER (arch-review 42 · 43, Three-Ledger Phases 1–2) ─────────────────────
//
// PHASE 1 WAS A DUAL-WRITE: rows stamped beside the commit points that already exist, best-effort at the
// call site, read by nobody to decide anything. The promotion path it named — the one `ScoringStageStore`
// documents (see ports/scoring-stage-store.ts) — was to move the write INSIDE the commit transaction, at
// which point a failure stops being best-effort and the caller's `.catch` goes with it.
//
// THAT STEP HAS LANDED FOR THE BATCH LANE'S TERMINAL STAMP (arch-review 43). A case's committed/failed stamp
// now rides `CaseReceiptStore.commitCase` — the same transaction as the receipt claim and the child's
// terminal write — because the window between them was not harmless: a crash there left a committed receipt
// naming an execution whose attempt row still said `created`, a receipt about an attempt the ledger never
// saw end. A stamp that throws there aborts the commit, which is the honest answer: the ledger could not
// record what the receipt is about to claim.
//
// AND IT HAS NOW LANDED FOR THE STANDALONE RUN LANE TOO (arch-review 45). That lane has no receipt to
// claim — the run ROW is its outcome record — so its commit point is the fenced terminal write itself:
// `RunStore.settleWith` applies the settlement and the attempt's terminal stamp as one decision, and
// `settleRun` routes a stamped settlement through it. Same contract as the batch's: a refused fence runs no
// stamp and rolls nothing back (the loser wrote nothing to undo), and a stamp that throws takes the terminal
// write with it, leaving the run OPEN for recovery rather than settled behind a ledger that could not record
// it. `settleWith` is optional, and that is the fallback rather than a loophole: a store with no transaction
// to offer keeps the two-step below, and the promotion is per-adapter, not per-lane.
//
// WHAT IS STILL BEST-EFFORT, and why each one has no transaction to ride: `executing` (no commit is being
// made), a loser's `superseded` (its claim was refused before any settle ran, or its transaction rolled back
// whole), a retry's abandon stamp (the abandoned attempt commits nothing), and both endings on a store
// without the atomic seam. Those rows are diagnostics: they say what ran, and no outcome is derived from
// them. That last clause is the rule that still holds everywhere — nothing may READ an attempt row to make a
// decision while any stamp of it is best-effort: a best-effort write that something depends on is a
// fail-open wearing a ledger's clothes.
//
// WHAT A LANE WITHOUT THE SEAM OWES (arch-review 44, still the contract wherever the promotion has not
// reached): ① the terminal stamp is AWAITED at the settle it records, never fired and forgotten — a driver
// that exits after settling has already written the row, so the only surviving window is a stamp that
// actually fails; and ② the attempt is addressed by its OWN coordinate, so an execution the recording fence
// refused (`unisolated`) still reaches a terminal state instead of standing at `created` for a run that
// succeeded. A stamp that fails is swallowed there, deliberately: failing a SUCCEEDED run because its
// diagnostic row could not be written would let the audit plane decide outcomes, which is the inversion this
// whole comment exists to prevent. It costs an incomplete row, and the reconciliation for those is the same
// one every pre-promotion row needs — an attempt row whose execution has a terminal child is not the child's
// authority on anything.
//
// TWO MINTING AUTHORITIES WOULD DRIFT. `open` is THE authority for the attempt ordinal: it computes MAX+1
// per executionId and returns the coordinate. The recording store, which used to mint its own by the same
// rule over its own table, now CLAIMS the coordinate it is handed (RecordingStore.open's `generation`
// parameter). Two independent MAX+1 computations over two tables agree only while both tables see exactly
// the same attempts — and the recording table is the one that is conditional, prunable and evidence-lifetime.
export interface ExecutionAttemptStore {
  // Mint the next attempt for this execution and INSERT it, state "created". Returns the coordinate — the
  // generation and the joined `attemptId` — because that coordinate is what every downstream stamp uses.
  open(input: OpenAttemptInput): Promise<{ attemptId: string; generation: number }>;
  // A GUARDED transition, with the two rules the state machine has:
  //   • "executing" only from "created" — an attempt cannot start after it has ended.
  //   • FIRST TERMINAL WINS — a terminal state is reachable only from a non-terminal one.
  // A refused transition returns false and is a SILENT NO-OP, never a throw: the second terminal write is
  // the ordinary shape here (a superseded attempt's late failure report arriving after the supersede landed),
  // and the caller's answer to it is nothing at all.
  transition(
    attemptId: string,
    to: ExecutionAttemptState,
    patch?: {
      childRunId?: string;
      leaseEpoch?: number;
      unisolated?: boolean;
      error?: { code: string; message: string };
    },
  ): Promise<boolean>;
  // WHERE this attempt's compute WILL BE, written before the backend creates it (arch-review 52 Wave 2 for the
  // column; arch-review 54 Phase 1 for the proof). Called from the reservation hook, which the backend awaits
  // before it submits anything.
  //
  // Its own verb rather than a `transition` patch for the same reason `markUnisolated` is one: it says nothing
  // about where the attempt stands in its life. It lands while the attempt is `created` or `executing`, and —
  // unlike a transition — it must still land on a TERMINAL row, because the row can go terminal before the
  // reservation does.
  //
  // RETURNS THE PROOF, and THROWS when there is none. It used to be `Promise<void>` over an UPDATE with no
  // affected-row check, defended by this reasoning:
  //
  //     "It is still best-effort because the alternative is failing a dispatch that already succeeded, which
  //      would make the audit plane able to kill live work."
  //
  // That was true while the stamp ran AFTER the apply. Wave A moved it before, and the justification did not
  // move with it: today a refused reservation costs a dispatch that has placed nothing, and buys the
  // guarantee that no external object exists whose name the ledger does not hold. Zero rows updated is the
  // case that matters — it means this attempt id names nothing — and it is a throw, not a silent success.
  //
  // ── AND IT IS A CONDITIONAL TRANSITION, NOT A METADATA UPDATE (arch-review 55, Wave 1) ─────────────
  //
  // `WHERE attempt_id = $1` proved the row EXISTS. It did not ask whether this caller may still act, so it
  // authorized a superseded attempt, a driver a takeover had displaced, and a batch the user had cancelled a
  // second earlier — each of which can no longer commit an outcome and could still bring new compute into
  // existence. The cancellation racing it never converges, because what it was converging on was created
  // after it looked.
  //
  // The write now asserts, in the one statement that flips `created → reserved`:
  //   • the attempt is `created` — a superseded or terminal one places nothing;
  //   • nothing is reserved yet — one attempt authorizes ONE piece of work, so the second dispatch onto it
  //     is refused rather than silently overwriting the column that names live compute (a re-reservation of
  //     the SAME external id is the caller repeating itself, and is idempotent);
  //   • the parent this attempt belongs to is still open AND still owned at the epoch it was opened under.
  //
  // That last clause is why `parents` exists on the constructor: the Pg twin asks it as a correlated EXISTS
  // inside the same UPDATE, and the in-memory twin asks the injected reader in the same synchronous block.
  // Same question, each with the mechanism its store actually has.
  reserveWork(attemptId: string, work: RuntimeWorkRef): Promise<PersistedWorkIntent>;
  // ── …AND THE PROOF IS RE-PRESENTED WHERE THE EFFECT BEGINS (arch-review 57 P0) ───────────────────
  //
  // `reserveWork` bounds who may RESERVE. It cannot bound how long the reservation stays good, and until
  // this existed nothing did: the caller that won one held it across whatever came next, and a cancellation
  // could kill the work, probe it absent, settle every child and complete — after which the paused caller
  // woke and created the object. A cancellation that verified zero live work, followed by live work.
  //
  // So the dispatch asks again at the seam where the external object is about to be created, and the answer
  // is a TRANSITION rather than a read: `reserved → active`, conditioned on this exact work id and on the
  // parent still being open. A revoked reservation fails here, which is what gives a cancellation something
  // to CAS against instead of a hope that nobody is mid-flight.
  //
  // Answers `already_active` for a repeat of the same work — at-least-once delivery is ordinary and a
  // re-driven dispatch must converge on the same object, not a second one. See `decideActivation`
  // (@everdict/contracts) for the decision this performs.
  activateWork(attemptId: string, work: RuntimeWorkRef): Promise<ActivationDecision>;
  // Take a reservation BACK. What a cancellation calls so a paused holder fails at activation instead of
  // creating work after the sweep certified there was none. Idempotent, and never revives a settled attempt.
  revokeReservation(attemptId: string): Promise<void>;
  // The attempt ran with no fence raised — the recording coordinate it minted could not be claimed. Its own
  // verb rather than a transition, because it says nothing about WHERE the attempt is in its life: an attempt
  // is marked unisolated while still "created", and it goes on to execute, commit or fail from there.
  markUnisolated(attemptId: string): Promise<void>;
  // Every physical attempt of one logical execution, oldest first — "what actually ran for this case".
  list(executionId: string): Promise<ExecutionAttemptRecord[]>;
  // Every attempt under one batch: the compute a scorecard actually spent, which its receipts (one per case)
  // structurally cannot report.
  listForScorecard(scorecardId: string): Promise<ExecutionAttemptRecord[]>;
}

// In-process ledger for dev/test — the same posture as the InMemory run/receipt stores. The ordinal comes
// from the rows themselves rather than a separate counter, so it stays the same computation the Pg adapter
// makes (MAX+1 over the execution's rows).
export class InMemoryExecutionAttemptStore implements ExecutionAttemptStore {
  private readonly attempts = new Map<string, ExecutionAttemptRecord>();

  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    // The parent ledger a reservation consults — see `reserveWork`. Optional: a store with no parents wired
    // (unit fixtures, the single-run CLI) keeps the state + already-reserved guards and skips the epoch one,
    // which is the honest degrade — those two need nothing outside this table.
    private readonly parents?: AttemptParentAuthority,
  ) {}

  async open(input: OpenAttemptInput): Promise<{ attemptId: string; generation: number }> {
    const prior = [...this.attempts.values()].filter((a) => a.executionId === input.executionId);
    const generation = Math.max(0, ...prior.map((a) => a.generation)) + 1;
    const attemptId = attemptIdOf(input.executionId, generation);
    const at = this.now();
    this.attempts.set(attemptId, {
      attemptId,
      executionId: input.executionId,
      generation,
      tenant: input.tenant,
      ...(input.scorecardId !== undefined ? { scorecardId: input.scorecardId } : {}),
      ...(input.caseId !== undefined ? { caseId: input.caseId } : {}),
      ...(input.trial !== undefined ? { trial: input.trial } : {}),
      ...(input.childRunId !== undefined ? { childRunId: input.childRunId } : {}),
      ...(input.driverEpoch !== undefined ? { driverEpoch: input.driverEpoch } : {}),
      state: "created",
      unisolated: false,
      openedAt: at,
      updatedAt: at,
    });
    return { attemptId, generation };
  }

  async transition(
    attemptId: string,
    to: ExecutionAttemptState,
    patch?: {
      childRunId?: string;
      leaseEpoch?: number;
      unisolated?: boolean;
      error?: { code: string; message: string };
    },
  ): Promise<boolean> {
    const current = this.attempts.get(attemptId);
    if (!current) return false;
    if (isTerminalAttemptState(current.state)) return false; // first terminal wins
    // …from `created`, `reserved` OR `active` (arch-review 55 Wave 1, widened by 58): a managed dispatch
    // authorizes its work first and then re-presents that authorization at the object's birth, so the row it
    // starts executing from is whichever of those three the lane last transitioned. The set is owned by
    // contracts because the Pg twin arbitrates on the same question.
    if (to === "executing" && !EXECUTING_PREDECESSOR_STATES.includes(current.state)) return false;
    if (to === "created") return false; // an attempt is opened into "created"; nothing transitions back to it
    this.attempts.set(attemptId, {
      ...current,
      state: to,
      ...(patch?.childRunId !== undefined ? { childRunId: patch.childRunId } : {}),
      ...(patch?.leaseEpoch !== undefined ? { leaseEpoch: patch.leaseEpoch } : {}),
      ...(patch?.unisolated !== undefined ? { unisolated: patch.unisolated } : {}),
      ...(patch?.error !== undefined ? { error: patch.error } : {}),
      updatedAt: this.now(),
    });
    return true;
  }

  async reserveWork(attemptId: string, work: RuntimeWorkRef): Promise<PersistedWorkIntent> {
    const current = this.attempts.get(attemptId);
    // The zero-row case, stated. A silent return here is what let a reservation hook resolve over an attempt
    // row that does not exist, which licensed the cluster object that followed it.
    if (!current)
      throw new NotFoundError(
        "NOT_FOUND",
        { attemptId },
        "cannot reserve runtime work against an attempt row that does not exist — the dispatch has no durable identity to place work under.",
      );
    // IDEMPOTENT for the same work: a caller re-reserving the exact external id is repeating itself, and
    // failing it would fail a dispatch that is correct. Checked before the state guard, because the retry
    // legitimately arrives when the row already says `reserved`.
    //
    // …BUT IT STILL ANSWERS TO THE PARENT (arch-review 56, Wave D). This returned the stored intent and asked
    // NOTHING — so between the first reservation and the retry the batch could be cancelled, superseded or
    // taken over at a new epoch, and the caller would still receive a capability and still submit. A
    // cancellation that converged on a world where the work did not exist then watched it appear afterwards.
    // Same identity is a reason to hand back the SAME handle rather than mint a second one; it is not a
    // reason to skip the question the guarded write exists to ask (L1: a proof has a lifetime).
    if (current.runtimeWork !== undefined) {
      if (current.runtimeWork.externalJobId === work.externalJobId) {
        await this.assertParentStillAuthorizes(attemptId, current);
        return { attemptId, work: current.runtimeWork, persistedAt: current.updatedAt };
      }
      throw new ConflictError(
        "CONFLICT",
        { attemptId, reserved: current.runtimeWork.externalJobId, offered: work.externalJobId },
        "this attempt has already authorized other work — overwriting the handle would leave the running job unaddressable.",
      );
    }
    if (current.state !== "created")
      throw new ConflictError(
        "CONFLICT",
        { attemptId, state: current.state },
        `an attempt in state '${current.state}' may not authorize new work — its outcome is no longer its own to decide.`,
      );
    // …and the parent must still be open and still ours. Synchronous with the write below (one JS turn), so
    // there is no window between the check and the effect — the property the Pg twin gets from its statement.
    await this.assertParentStillAuthorizes(attemptId, current);
    const persistedAt = this.now();
    this.attempts.set(attemptId, { ...current, state: "reserved", runtimeWork: work, updatedAt: persistedAt });
    return { attemptId, work, persistedAt };
  }

  // ONE ANSWER, BOTH PATHS (arch-review 56, Wave D). Extracted so the idempotent return cannot drift from the
  // guarded write — the two used to be a check and a shortcut past it, which is the whole defect.
  async activateWork(attemptId: string, work: RuntimeWorkRef): Promise<ActivationDecision> {
    const current = this.attempts.get(attemptId);
    if (!current) return { kind: "refuse", reason: "this attempt row does not exist" };
    // The parent question, asked as a boolean rather than by throwing: an activation refusal is a normal
    // answer a lane acts on (it aborts the dispatch), not an exception to be caught somewhere generic.
    let parentOpen = true;
    try {
      await this.assertParentStillAuthorizes(attemptId, current);
    } catch {
      parentOpen = false;
    }
    const decision = decideActivation({
      state: current.state,
      recordedWork: current.runtimeWork?.externalJobId,
      work: work.externalJobId,
      parentOpen,
    });
    // The transition IS the decision, in the same block that made it — a caller that read `activate` and
    // then wrote separately would have reopened the window this closes.
    if (decision.kind === "activate")
      this.attempts.set(attemptId, { ...current, state: "active", updatedAt: this.now() });
    return decision;
  }

  async revokeReservation(attemptId: string): Promise<void> {
    const current = this.attempts.get(attemptId);
    // A settled attempt is not revived into `revoked`, and a missing row needs nothing taken back. Both are
    // no-ops rather than errors: a cancellation sweeping a batch must not fail on an attempt that already
    // finished on its own.
    if (!current || isTerminalAttemptState(current.state)) return;
    this.attempts.set(attemptId, { ...current, state: "revoked", updatedAt: this.now() });
  }

  private async assertParentStillAuthorizes(attemptId: string, current: ExecutionAttemptRecord): Promise<void> {
    const parent = await this.parents?.authorityOf(current);
    if (this.parents !== undefined && parent === undefined)
      throw new ConflictError(
        "CONFLICT",
        { attemptId },
        "the execution this attempt belongs to is no longer open — work placed for it could never be torn down by the cancellation that already ran.",
      );
    if (parent !== undefined && current.driverEpoch !== undefined && parent.epoch !== current.driverEpoch)
      throw new ConflictError(
        "CONFLICT",
        { attemptId, held: current.driverEpoch, current: parent.epoch },
        "this driver has been displaced by a newer epoch — it may no longer authorize work it could not settle.",
      );
  }

  async markUnisolated(attemptId: string): Promise<void> {
    const current = this.attempts.get(attemptId);
    if (!current) return;
    this.attempts.set(attemptId, { ...current, unisolated: true, updatedAt: this.now() });
  }

  async list(executionId: string): Promise<ExecutionAttemptRecord[]> {
    return [...this.attempts.values()]
      .filter((a) => a.executionId === executionId)
      .sort((a, b) => a.generation - b.generation);
  }

  async listForScorecard(scorecardId: string): Promise<ExecutionAttemptRecord[]> {
    return [...this.attempts.values()]
      .filter((a) => a.scorecardId === scorecardId)
      .sort((a, b) =>
        a.executionId === b.executionId ? a.generation - b.generation : a.executionId < b.executionId ? -1 : 1,
      );
  }
}

// ── WHO MAY STILL AUTHORIZE WORK, IN ONE PLACE (arch-review 56, Wave A) ─────────────────────────────
//
// The in-process twin of the Postgres reservation's correlated EXISTS. It lived as a closure in the API's
// composition root and hand-wrote its own vocabulary (`status === "succeeded" || status === "failed"`) — the
// same drift the SQL had, in the one lane a counterexample could actually drive. So the two adapters agreed
// with each other and both disagreed with the domain, and a test comparing them would have agreed too.
//
// It reads the OPEN allowlist rather than a terminal check, for the reason the allowlist exists: a status
// added to the enum tomorrow is excluded until somebody classifies it, instead of silently joining the
// permitted side.
export function attemptParentAuthority(stores: {
  scorecards: { get: (id: string) => Promise<{ status: string; ownerEpoch?: number } | undefined> };
  runs: { get: (id: string) => Promise<{ status: string; ownerEpoch?: number } | undefined> };
}): AttemptParentAuthority {
  return {
    async authorityOf(attempt) {
      if (attempt.scorecardId !== undefined) {
        const parent = await stores.scorecards.get(attempt.scorecardId);
        if (!parent || !(OPEN_SCORECARD_STATUSES as readonly string[]).includes(parent.status)) return undefined;
        return { epoch: parent.ownerEpoch ?? 0 };
      }
      const runId = attempt.executionId.startsWith("evd-run-") ? attempt.executionId.slice("evd-run-".length) : "";
      const run = runId === "" ? undefined : await stores.runs.get(runId);
      // An execution with no parent row this store can name — the CLI's own lane — keeps the state and
      // already-reserved guards and skips the epoch one. "We cannot check what nobody recorded" is not a
      // licence, and it is also not a reason to refuse a lane that has no parent to be displaced from.
      if (runId === "" || !run) return { epoch: attempt.driverEpoch ?? 0 };
      if (!(OPEN_RUN_STATUSES as readonly string[]).includes(run.status)) return undefined;
      return { epoch: run.ownerEpoch ?? 0 };
    },
  };
}
