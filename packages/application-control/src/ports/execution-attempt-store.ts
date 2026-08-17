import {
  type ExecutionAttemptRecord,
  type ExecutionAttemptState,
  NotFoundError,
  type PersistedWorkIntent,
  type RuntimeWorkRef,
  attemptIdOf,
  isTerminalAttemptState,
} from "@everdict/contracts";

// What an attempt is opened WITH — everything the opener already knows about the execution it is about to
// start. Nothing here is discovered later except `childRunId`, which the batch lanes learn a few lines after
// the open (the child row is created under the coordinate this call mints), so it is patchable on transition.
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
  reserveWork(attemptId: string, work: RuntimeWorkRef): Promise<PersistedWorkIntent>;
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

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

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
    if (to === "executing" && current.state !== "created") return false;
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
    const persistedAt = this.now();
    this.attempts.set(attemptId, { ...current, runtimeWork: work, updatedAt: persistedAt });
    return { attemptId, work, persistedAt };
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
