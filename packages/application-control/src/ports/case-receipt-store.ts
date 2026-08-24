import { type CaseCommitOutcome, type CaseCommitReceipt, type ReadResult, readOrUnknown } from "@everdict/contracts";
import type { RunRecord } from "@everdict/contracts";
import type { ExecutionAttemptStore } from "./execution-attempt-store.js";
import type { RunStore } from "./run-store.js";

// ── WHERE A CASE'S CANONICAL OUTCOME IS DECIDED (review 39 P0 · review 40 P0) ────────────────────────
//
// `commitCase` is the commit point: the receipt claim AND the child's terminal write, as ONE decision.
// They used to be two independent round-trips, and the gap between them was a poison pill — a receipt that
// had permanently claimed the case for a child whose terminal write was then refused (a parent takeover, a
// transient store error) left the case uncommittable forever: the claim said "this child is the answer" and
// the child never carried one. Claiming the right to commit is not the commit.
//
// The contract: the receipt persists IF AND ONLY IF `settle` returned a settled record. A refused settle
// (undefined — the fence said no) rolls the claim back and reports `unsettled`; a settle that THROWS rolls
// the claim back and rethrows (a store fault is reported as one, never converted into an outcome).
//
// `commit` remains as the RAW claim for exactly one purpose: certifying the claim constraint itself (the
// trust fixtures race it directly). Every LIVE path — executed, failed and inherited outcomes alike — goes
// through `commitCase`; the structural scan in case-commit-guard.test.ts holds the allowlist at zero.
//
// The store is deliberately not a general CRUD surface: there is no update and no delete. A receipt is the
// record of a decision, and a decision that can be edited is not one.
export type CaseSettleOutcome =
  | { kind: "committed"; receipt: CaseCommitReceipt }
  // Another attempt owns the case (or this very child already committed — the idempotent retry). The winner's
  // receipt rides along so the loser never has to re-read (which would be racing again).
  | { kind: "already_committed"; receipt: CaseCommitReceipt }
  // The child's terminal write was REFUSED by its fence (takeover / cancel / already terminal). No receipt
  // was persisted — the case is still claimable by whoever holds the authority now.
  | { kind: "unsettled" }
  // ── "THE COMMIT THREW" IS NOT "THE COMMIT DID NOT HAPPEN" (arch-review 66 P1-lifecycle) ────────────
  //
  // A connection reset after Postgres wrote the rows raises exactly like a failed insert, and the batch
  // recovery turned both into `undefined` and re-dispatched the case. The second attempt loses the receipt
  // claim, so the ledger stays honest — and the compute was already spent, which is the cost this arm exists
  // to stop. Same distinction `runSuite` learned for compensation (rule `suite`: an exception is not proof
  // that a commit did not happen).
  //
  // The caller's answer is to READ BACK, never to decide: the exact receipt plus its child says committed,
  // both absent says safe to retry, and a read that also fails leaves the whole batch owed.
  | { kind: "unknown"; reason: string };

export interface CaseReceiptStore {
  // The raw claim — seeding/backfill only (see above). `already_committed` carries the receipt that won.
  commit(receipt: CaseCommitReceipt): Promise<CaseCommitOutcome>;
  // The atomic commit point: claim the case AND apply the child's terminal write, all-or-nothing. `settle`
  // receives the run store the write must go through — an implementation that can open a transaction hands
  // a transaction-bound twin; one that cannot (in-memory, single-process) hands `runs` back. The closure
  // returns the settled record, or undefined when the fence refused.
  //
  // …and the PHYSICAL ATTEMPT's terminal stamp rides the same decision (arch-review 43, the promotion the
  // attempt port documents). The second argument is the attempt ledger the stamp must go through, bound to
  // the same transaction by the same rule as `runs`; `undefined` means no ledger is wired and there is
  // nothing to stamp. A throw from that stamp aborts the commit exactly like any other store fault — the
  // ledger could not record what the receipt is about to claim, so the receipt is not made.
  commitCase(
    receipt: CaseCommitReceipt,
    settle: (runs: RunStore, attempts?: ExecutionAttemptStore) => Promise<RunRecord | undefined>,
    runs: RunStore,
    // The caller's ambient ledger, for the implementations that cannot bind one to a transaction — the same
    // seam `runs` is, and passed by the caller rather than wired at construction so the store the service
    // stamps through can never drift from the one it opened the attempt on.
    attempts?: ExecutionAttemptStore,
  ): Promise<CaseSettleOutcome>;
  // Every receipt of one batch — the parent's aggregation input, and the parity check against the ledger.
  list(scorecardId: string): Promise<CaseCommitReceipt[]>;
  // The same listing, three-valued (arch-review 53, Wave A.5). `list` throws on a ledger fault and every
  // decision-grade caller was wrapping it in `.catch(() => [])`, which turns "the ledger is down" into "this
  // batch committed nothing" — and the evidence read downstream then serves whichever plane sealed first
  // instead of the attempt the receipt named. Callers that DECIDE on the answer use this one; a list endpoint
  // that should 500 keeps using `list`.
  read(scorecardId: string): Promise<ReadResult<CaseCommitReceipt[]>>;
}

// In-process store for dev/test — the same posture as the InMemory run/scorecard stores. The Map key is the
// (scorecard, case, trial) tuple, which is the constraint the Pg table expresses as its primary key.
export class InMemoryCaseReceiptStore implements CaseReceiptStore {
  private readonly receipts = new Map<string, CaseCommitReceipt>();
  // Per-key serialization for commitCase — the in-memory stand-in for the Pg transaction. Two concurrent
  // commits of one (scorecard, case, trial) would otherwise interleave across the settle's await and both
  // report `committed`.
  private readonly commits = new Map<string, Promise<unknown>>();

  private static key(r: Pick<CaseCommitReceipt, "scorecardId" | "caseId" | "trial">): string {
    // NUL-joined (spelled as an escape — a literal byte is invisible and edit-hostile): ids are user-adjacent
    // strings, and a printable separator lets `("sc a", "b")` alias `("sc", "a b")` across the tuple.
    return `${r.scorecardId}\u0000${r.caseId}\u0000${r.trial}`;
  }

  async commit(receipt: CaseCommitReceipt): Promise<CaseCommitOutcome> {
    const key = InMemoryCaseReceiptStore.key(receipt);
    const existing = this.receipts.get(key);
    if (existing) return { kind: "already_committed", receipt: existing };
    this.receipts.set(key, receipt);
    return { kind: "committed", receipt };
  }

  async commitCase(
    receipt: CaseCommitReceipt,
    settle: (runs: RunStore, attempts?: ExecutionAttemptStore) => Promise<RunRecord | undefined>,
    runs: RunStore,
    // Handed straight back, like `runs`: a single-process store has no transaction to bind a twin to. What it
    // therefore cannot give is ROLLBACK — a stamp that throws leaves this store's receipt unmade (the decision
    // is un-happened, which is the guarantee that matters) but cannot un-write what the settle already wrote.
    // The Pg twin is where the promotion is atomic; this one keeps the ordering and the refusal.
    attempts?: ExecutionAttemptStore,
  ): Promise<CaseSettleOutcome> {
    const key = InMemoryCaseReceiptStore.key(receipt);
    const prior = this.commits.get(key) ?? Promise.resolve();
    const task = prior.then(async (): Promise<CaseSettleOutcome> => {
      const existing = this.receipts.get(key);
      if (existing) return { kind: "already_committed", receipt: existing };
      // The settle runs BEFORE the claim is visible, exactly like the Pg transaction: a throw or a refusal
      // leaves no receipt behind. Serialization above is what makes check-settle-set atomic here.
      const settled = await settle(runs, attempts);
      if (settled === undefined) return { kind: "unsettled" };
      this.receipts.set(key, receipt);
      return { kind: "committed", receipt };
    });
    this.commits.set(
      key,
      task.then(
        () => undefined,
        () => undefined,
      ),
    );
    return task;
  }

  async read(scorecardId: string): Promise<ReadResult<CaseCommitReceipt[]>> {
    return readOrUnknown(() => this.list(scorecardId), `receipt ledger for ${scorecardId}`);
  }

  async list(scorecardId: string): Promise<CaseCommitReceipt[]> {
    return [...this.receipts.values()].filter((r) => r.scorecardId === scorecardId);
  }

  // Synchronous count for the scorecard store's receipt-count pairing (expectReceiptCount) — the in-memory
  // stand-in for the Pg sub-select evaluated inside the terminal write's own statement.
  countFor(scorecardId: string): number {
    let n = 0;
    for (const r of this.receipts.values()) if (r.scorecardId === scorecardId) n += 1;
    return n;
  }
}
