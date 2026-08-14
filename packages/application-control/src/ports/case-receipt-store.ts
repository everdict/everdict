import type { CaseCommitOutcome, CaseCommitReceipt } from "@everdict/contracts";
import type { RunRecord } from "@everdict/contracts";
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
// `commit` remains as the RAW claim for the two callers that genuinely have no child write to couple:
// seeding a carried-over result whose child row is born terminal, and certifying the claim constraint
// itself. Every finalization path goes through `commitCase`.
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
  | { kind: "unsettled" };

export interface CaseReceiptStore {
  // The raw claim — seeding/backfill only (see above). `already_committed` carries the receipt that won.
  commit(receipt: CaseCommitReceipt): Promise<CaseCommitOutcome>;
  // The atomic commit point: claim the case AND apply the child's terminal write, all-or-nothing. `settle`
  // receives the run store the write must go through — an implementation that can open a transaction hands
  // a transaction-bound twin; one that cannot (in-memory, single-process) hands `runs` back. The closure
  // returns the settled record, or undefined when the fence refused.
  commitCase(
    receipt: CaseCommitReceipt,
    settle: (runs: RunStore) => Promise<RunRecord | undefined>,
    runs: RunStore,
  ): Promise<CaseSettleOutcome>;
  // Every receipt of one batch — the parent's aggregation input, and the parity check against the ledger.
  list(scorecardId: string): Promise<CaseCommitReceipt[]>;
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
    settle: (runs: RunStore) => Promise<RunRecord | undefined>,
    runs: RunStore,
  ): Promise<CaseSettleOutcome> {
    const key = InMemoryCaseReceiptStore.key(receipt);
    const prior = this.commits.get(key) ?? Promise.resolve();
    const task = prior.then(async (): Promise<CaseSettleOutcome> => {
      const existing = this.receipts.get(key);
      if (existing) return { kind: "already_committed", receipt: existing };
      // The settle runs BEFORE the claim is visible, exactly like the Pg transaction: a throw or a refusal
      // leaves no receipt behind. Serialization above is what makes check-settle-set atomic here.
      const settled = await settle(runs);
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

  async list(scorecardId: string): Promise<CaseCommitReceipt[]> {
    return [...this.receipts.values()].filter((r) => r.scorecardId === scorecardId);
  }
}
