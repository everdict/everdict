import type {
  CaseReceiptStore,
  CaseSettleOutcome,
  ExecutionAttemptStore,
  ExecutionPassAuthority,
  IntermediateCleanupStore,
  RunStore,
} from "@everdict/application-control";
import {
  type CaseCommitOutcome,
  type CaseCommitReceipt,
  InternalError,
  type ReadResult,
  type RunRecord,
  readOrUnknown,
} from "@everdict/contracts";
import { type SqlClient, withTransaction } from "../client.js";
import { PgExecutionAttemptStore } from "./pg-execution-attempt-store.js";
import { PgIntermediateCleanupStore } from "./pg-intermediate-cleanup-store.js";
import { PgRunStore } from "./pg-run-store.js";

interface ReceiptRow {
  scorecard_id: string;
  case_id: string;
  trial: number;
  child_run_id: string;
  kind: string | null;
  source_scorecard_id: string | null;
  execution_id: string | null;
  generation: number | null;
  attempt_id: string | null;
  result_digest: string;
  observation_digest: string | null;
  judge_closure_digest: string | null;
  committed_at: string | Date;
}

function toReceipt(row: ReceiptRow): CaseCommitReceipt {
  return {
    scorecardId: row.scorecard_id,
    caseId: row.case_id,
    trial: Number(row.trial),
    childRunId: row.child_run_id,
    // Narrowed by value, not cast: an unknown string in the column reads as "kind unrecorded" rather than
    // flowing through as a fabricated variant.
    ...(row.kind === "executed" || row.kind === "failed" || row.kind === "inherited" ? { kind: row.kind } : {}),
    ...(row.source_scorecard_id !== null ? { sourceScorecardId: row.source_scorecard_id } : {}),
    ...(row.execution_id !== null ? { executionId: row.execution_id } : {}),
    ...(row.generation !== null ? { generation: Number(row.generation) } : {}),
    ...(row.attempt_id !== null ? { attemptId: row.attempt_id } : {}),
    resultDigest: row.result_digest,
    ...(row.observation_digest !== null ? { observationDigest: row.observation_digest } : {}),
    ...(row.judge_closure_digest !== null ? { judgeClosureDigest: row.judge_closure_digest } : {}),
    committedAt: new Date(row.committed_at).toISOString(),
  };
}

// Module-private control-flow signal for commitCase — a refused child fence must ROLLBACK the transaction
// (the helper's contract for a throw) and then surface as the `unsettled` OUTCOME, not as an error. Never
// crosses this file's boundary.
class UnsettledSignal extends Error {
  constructor() {
    super("case commit unsettled — the child's fence refused the write, the claim was rolled back");
  }
}

// Postgres-backed case-commit receipts (mig 0175). The whole store is one statement: the INSERT is the claim,
// and the primary key decides it.
export class PgCaseReceiptStore implements CaseReceiptStore {
  constructor(private readonly client: SqlClient) {}

  // THE CLAIM IS ONE STATEMENT, because a claim that reads first is not a claim (the lesson every terminal
  // write here has already learned). What the loser needs afterwards — WHOSE case it is — cannot always come
  // from that same statement, and the multi-process race (TRUST-169) is what proved it: a data-modifying CTE
  // and the query around it share ONE SNAPSHOT, taken before the statement ran. `ON CONFLICT DO NOTHING`
  // waits for the competing transaction and then skips, but the `SELECT` half is still looking at the table
  // as it was BEFORE that transaction committed — so the loser saw no row at all and the store threw.
  //
  // Failing closed there was right (an unreadable decision is not a decision in our favour), and it is not an
  // answer. The follow-up read is a SECOND statement precisely so it gets a fresh snapshot, and it is not a
  // race: by the time the first statement returned, the conflicting row was committed — that is what the
  // insert waited for.
  async commit(receipt: CaseCommitReceipt): Promise<CaseCommitOutcome> {
    return this.commitOn(this.client, receipt);
  }

  private async commitOn(client: SqlClient, receipt: CaseCommitReceipt): Promise<CaseCommitOutcome> {
    const { rows } = await client.query<ReceiptRow & { inserted: boolean }>(
      `WITH claim AS (
         INSERT INTO everdict_case_commit_receipts
           (scorecard_id, case_id, trial, child_run_id, kind, source_scorecard_id, execution_id, generation,
            attempt_id, result_digest, observation_digest, judge_closure_digest, committed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (scorecard_id, case_id, trial) DO NOTHING
         RETURNING *, true AS inserted
       )
       SELECT * FROM claim
       UNION ALL
       SELECT *, false AS inserted FROM everdict_case_commit_receipts
        WHERE scorecard_id = $1 AND case_id = $2 AND trial = $3
          AND NOT EXISTS (SELECT 1 FROM claim)`,
      [
        receipt.scorecardId,
        receipt.caseId,
        receipt.trial,
        receipt.childRunId,
        receipt.kind ?? null,
        receipt.sourceScorecardId ?? null,
        receipt.executionId ?? null,
        receipt.generation ?? null,
        receipt.attemptId ?? null,
        receipt.resultDigest,
        receipt.observationDigest ?? null,
        receipt.judgeClosureDigest ?? null,
        receipt.committedAt,
      ],
    );
    const row = rows[0];
    if (row) return { kind: row.inserted ? "committed" : "already_committed", receipt: toReceipt(row) };
    // Refused, and the winner was invisible to this statement's snapshot (see above). Read it now.
    const { rows: settled } = await client.query<ReceiptRow>(
      `SELECT * FROM everdict_case_commit_receipts
        WHERE scorecard_id = $1 AND case_id = $2 AND trial = $3`,
      [receipt.scorecardId, receipt.caseId, receipt.trial],
    );
    const winner = settled[0];
    // Neither inserted nor found even now would mean the row that refused the insert has since vanished, and
    // nothing deletes a receipt — so this is a store fault, not an outcome to interpret. Reporting it as
    // "somebody else committed" would invent a winner nobody can name.
    if (!winner)
      throw new InternalError(
        "UPSTREAM_ERROR",
        { scorecard: receipt.scorecardId, caseId: receipt.caseId, trial: receipt.trial },
        "case receipt claim returned no row — neither inserted nor found",
      );
    return { kind: "already_committed", receipt: toReceipt(winner) };
  }

  // ── THE COMMIT POINT IS ONE TRANSACTION (review 40 P0) ─────────────────────────────────────────────
  //
  // The receipt claim and the child's terminal write, all-or-nothing. As two independent round-trips, the
  // window between them was a poison pill: the claim landed, a parent takeover (or a transient store error)
  // refused the child's write, and the case was permanently claimed for a child that never carried its
  // result — the successor's re-drive then met `already_committed` naming a non-terminal child, forever.
  //
  // Inside the transaction the claim goes FIRST (the cheap conflict detection — a loser rolls back having
  // written nothing and is told whose case it is), the child's fenced write second. A refused fence aborts
  // the transaction, taking the claim with it. A concurrent claimant blocks on the in-flight insert until
  // this transaction commits or rolls back, so the two-statement winner read below stays race-free.
  //
  // …AND THE ATTEMPT'S TERMINAL STAMP RIDES IT TOO (arch-review 43). The physical ledger used to be stamped
  // after `commitCase` resolved, best-effort: a crash in that window left a committed receipt beside an
  // attempt row still saying `created` — the receipt claiming an execution the ledger never saw end. Both
  // twins below are bound to `tx`, so the receipt, the child's terminal write and the attempt's terminal
  // state are one decision or none of them.
  // ── THE SUPERSEDING CLAIM (docs/architecture/in-place-case-retry-spec.md) ─────────────────────────
  //
  // The ordinary claim above is an insert that must not overwrite: `ON CONFLICT DO NOTHING`, because a
  // receipt is the record of a decision and a decision that can be edited is not one. This does not edit
  // one either — it makes a NEW decision under a named authority and hands the displaced one back, so the
  // caller can preserve it verbatim on the scorecard's attempt ledger.
  //
  // ONE statement, because a read-then-write is not a claim. `prior` reads the row this commit is about to
  // replace, from the same statement's snapshot, so the receipt reported as displaced is the one that was
  // actually displaced.
  //
  // ⚠️ NO `FOR UPDATE` HERE, AND THAT IS THE POINT. The first version had one — the obvious way to make a
  // read-then-replace safe — and against a real Postgres it made `prior` come back EMPTY every time: a row
  // being updated by the same statement cannot be locked by that statement's own CTE, so the lock quietly
  // became a skip. The upsert still moved the pointer, so the outcome read `committed` with no displaced
  // receipt and the caller would have had nothing to preserve — the supersession degrading into exactly the
  // silent edit this design exists to refuse, with a green SQL-text test either way. Found only by running
  // it (skill `code-review` pass 6: the adapter is certified by a real engine or by nothing).
  //
  // MATERIALIZED pins it: `prior` is evaluated once, before the write, rather than left for a planner to
  // inline into the join where it would re-read the updated row.
  //
  // What the lock was for is handled upstream instead. Two supersessions of one key cannot race, because an
  // authority is minted only from a live `execution_pass` and that marker's claim is a compare-and-swap
  // admitting exactly one pass per record. If that ever stops being true, this statement is where it shows —
  // as two callers each believing they displaced the same receipt.
  private async supersedeOn(
    client: SqlClient,
    receipt: CaseCommitReceipt,
  ): Promise<Extract<CaseSettleOutcome, { kind: "committed" | "superseded" }>> {
    const { rows } = await client.query<ReceiptRow & { displaced: ReceiptRow | null }>(
      `WITH prior AS MATERIALIZED (
         SELECT * FROM everdict_case_commit_receipts
          WHERE scorecard_id = $1 AND case_id = $2 AND trial = $3
       ), upsert AS (
         INSERT INTO everdict_case_commit_receipts
           (scorecard_id, case_id, trial, child_run_id, kind, source_scorecard_id, execution_id, generation,
            attempt_id, result_digest, observation_digest, judge_closure_digest, committed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (scorecard_id, case_id, trial) DO UPDATE SET
           child_run_id = EXCLUDED.child_run_id,
           kind = EXCLUDED.kind,
           source_scorecard_id = EXCLUDED.source_scorecard_id,
           execution_id = EXCLUDED.execution_id,
           generation = EXCLUDED.generation,
           attempt_id = EXCLUDED.attempt_id,
           result_digest = EXCLUDED.result_digest,
           observation_digest = EXCLUDED.observation_digest,
           judge_closure_digest = EXCLUDED.judge_closure_digest,
           committed_at = EXCLUDED.committed_at
         RETURNING *
       )
       SELECT upsert.*, to_jsonb(prior) AS displaced
         FROM upsert LEFT JOIN prior ON true`,
      [
        receipt.scorecardId,
        receipt.caseId,
        receipt.trial,
        receipt.childRunId,
        receipt.kind ?? null,
        receipt.sourceScorecardId ?? null,
        receipt.executionId ?? null,
        receipt.generation ?? null,
        receipt.attemptId ?? null,
        receipt.resultDigest,
        receipt.observationDigest ?? null,
        receipt.judgeClosureDigest ?? null,
        receipt.committedAt,
      ],
    );
    const row = rows[0];
    // An upsert that returned nothing is a store fault, not an outcome: the statement either inserts or
    // updates, and reporting "nobody committed" over a write that may have landed is the one direction
    // this ledger must never fail in.
    if (!row)
      throw new InternalError(
        "UPSTREAM_ERROR",
        { scorecard: receipt.scorecardId, caseId: receipt.caseId, trial: receipt.trial },
        "the superseding receipt claim returned no row.",
      );
    const prior = row.displaced;
    // No prior row means this pass retried a case that had never committed — which is a legitimate shape
    // (a case the original batch never got to), and an ordinary commit rather than a supersession.
    return prior === null
      ? { kind: "committed", receipt: toReceipt(row) }
      : { kind: "superseded", receipt: toReceipt(row), displaced: toReceipt(prior) };
  }

  async commitCase(
    receipt: CaseCommitReceipt,
    settle: (
      runs: RunStore,
      attempts?: ExecutionAttemptStore,
      cleanup?: IntermediateCleanupStore,
    ) => Promise<RunRecord | undefined>,
    // The caller's ambient stores — deliberately unused here: the settle must go through the SAME transaction
    // as the claim, so transaction-bound twins are handed in instead. The parameters exist because the
    // in-memory implementation has no transaction to bind one to.
    _runs: RunStore,
    _attempts?: ExecutionAttemptStore,
    _cleanup?: IntermediateCleanupStore,
    authority?: ExecutionPassAuthority,
  ): Promise<CaseSettleOutcome> {
    // An authority is for ONE record: a pass on batch A may not move batch B's pointers, and nothing else
    // in this store would notice. Checked here rather than trusted, because the caller assembling the
    // receipt and the caller holding the authority are the same code and a mismatch is a wiring bug.
    const superseding = authority !== undefined && authority.scorecardId === receipt.scorecardId;
    try {
      return await withTransaction(this.client, "the case commit (receipt + child settle)", async (tx) => {
        const outcome = superseding ? await this.supersedeOn(tx, receipt) : await this.commitOn(tx, receipt);
        if (outcome.kind === "already_committed") return outcome;
        // …and the cleanup ledger, bound to the SAME transaction (arch-review 71 P1). The release used to
        // run after this commit returned, so a crash in the gap left an already-terminal case holding
        // `retained` artifacts that `due()` never returns.
        const settled = await settle(
          new PgRunStore(tx),
          new PgExecutionAttemptStore(tx),
          new PgIntermediateCleanupStore(tx),
        );
        // The fence refused the child's write → abort, which rolls the claim back too. Thrown (not returned)
        // because ROLLBACK is the transaction helper's contract for a throw; unwrapped below.
        if (settled === undefined) throw new UnsettledSignal();
        // The supersession's displaced receipt must survive to the caller — it is the only copy of the
        // decision this commit replaced, and the caller owes it a home on the attempt ledger.
        return outcome.kind === "superseded"
          ? { kind: "superseded" as const, receipt: outcome.receipt, displaced: outcome.displaced }
          : { kind: "committed" as const, receipt: outcome.receipt };
      });
    } catch (err) {
      if (err instanceof UnsettledSignal) return { kind: "unsettled" };
      throw err; // a store fault is reported as one — never converted into an outcome
    }
  }

  // Three-valued read (arch-review 53, Wave A.5) — see the port. A Postgres fault answers `unknown`, never
  // an empty ledger, so a decision-grade caller can refuse instead of substituting.
  async read(scorecardId: string): Promise<ReadResult<CaseCommitReceipt[]>> {
    return readOrUnknown(() => this.list(scorecardId), `receipt ledger for ${scorecardId}`);
  }

  async list(scorecardId: string): Promise<CaseCommitReceipt[]> {
    const { rows } = await this.client.query<ReceiptRow>(
      "SELECT * FROM everdict_case_commit_receipts WHERE scorecard_id = $1 ORDER BY case_id, trial",
      [scorecardId],
    );
    return rows.map(toReceipt);
  }
}
