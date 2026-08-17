import type {
  CaseReceiptStore,
  CaseSettleOutcome,
  ExecutionAttemptStore,
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
  async commitCase(
    receipt: CaseCommitReceipt,
    settle: (runs: RunStore, attempts?: ExecutionAttemptStore) => Promise<RunRecord | undefined>,
    // The caller's ambient run store and ledger — deliberately unused here: the settle must go through the
    // SAME transaction as the claim, so transaction-bound twins are handed in instead. The parameters exist
    // because the in-memory implementation has no transaction to bind one to.
    _runs: RunStore,
    _attempts?: ExecutionAttemptStore,
  ): Promise<CaseSettleOutcome> {
    try {
      return await withTransaction(this.client, "the case commit (receipt + child settle)", async (tx) => {
        const outcome = await this.commitOn(tx, receipt);
        if (outcome.kind === "already_committed") return outcome;
        const settled = await settle(new PgRunStore(tx), new PgExecutionAttemptStore(tx));
        // The fence refused the child's write → abort, which rolls the claim back too. Thrown (not returned)
        // because ROLLBACK is the transaction helper's contract for a throw; unwrapped below.
        if (settled === undefined) throw new UnsettledSignal();
        return { kind: "committed" as const, receipt: outcome.receipt };
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
