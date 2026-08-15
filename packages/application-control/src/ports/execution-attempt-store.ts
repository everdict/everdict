import {
  type ExecutionAttemptRecord,
  type ExecutionAttemptState,
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

// ── THE PHYSICAL EXECUTION LEDGER (arch-review 42, Three-Ledger Phase 1) ─────────────────────────────
//
// PHASE 1 IS A DUAL-WRITE, and saying so here is the point. These rows are an OBSERVED spine: stamped beside
// the commit points that already exist (best-effort at the call site, durable in the store), read by nobody
// to decide anything. Every guarantee in the execution lanes still rests on the receipt, the recording fence
// and the child's terminal write, exactly as it did before — so a failure to stamp an attempt row degrades
// the audit trail and changes no outcome, which is why the callers may swallow it.
//
// The promotion path is the one `ScoringStageStore` documents (see ports/scoring-stage-store.ts): dual-write
// until the two planes have been watched agreeing on real traffic, then move the write INSIDE the commit
// transaction as the contract step, at which point a failure here stops being best-effort and the callers'
// `.catch` must go with it. Until that step lands, nothing may read an attempt row to make a decision — a
// best-effort write that something depends on is a fail-open wearing a ledger's clothes.
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
