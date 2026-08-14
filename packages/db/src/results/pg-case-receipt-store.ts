import type { CaseReceiptStore } from "@everdict/application-control";
import type { CaseCommitOutcome, CaseCommitReceipt } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

interface ReceiptRow {
  scorecard_id: string;
  case_id: string;
  trial: number;
  child_run_id: string;
  execution_id: string | null;
  generation: number | null;
  attempt_id: string | null;
  result_digest: string;
  judge_closure_digest: string | null;
  committed_at: string | Date;
}

function toReceipt(row: ReceiptRow): CaseCommitReceipt {
  return {
    scorecardId: row.scorecard_id,
    caseId: row.case_id,
    trial: Number(row.trial),
    childRunId: row.child_run_id,
    ...(row.execution_id !== null ? { executionId: row.execution_id } : {}),
    ...(row.generation !== null ? { generation: Number(row.generation) } : {}),
    ...(row.attempt_id !== null ? { attemptId: row.attempt_id } : {}),
    resultDigest: row.result_digest,
    ...(row.judge_closure_digest !== null ? { judgeClosureDigest: row.judge_closure_digest } : {}),
    committedAt: new Date(row.committed_at).toISOString(),
  };
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
    const { rows } = await this.client.query<ReceiptRow & { inserted: boolean }>(
      `WITH claim AS (
         INSERT INTO everdict_case_commit_receipts
           (scorecard_id, case_id, trial, child_run_id, execution_id, generation, attempt_id, result_digest,
            judge_closure_digest, committed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
        receipt.executionId ?? null,
        receipt.generation ?? null,
        receipt.attemptId ?? null,
        receipt.resultDigest,
        receipt.judgeClosureDigest ?? null,
        receipt.committedAt,
      ],
    );
    const row = rows[0];
    if (row) return { kind: row.inserted ? "committed" : "already_committed", receipt: toReceipt(row) };
    // Refused, and the winner was invisible to this statement's snapshot (see above). Read it now.
    const { rows: settled } = await this.client.query<ReceiptRow>(
      `SELECT * FROM everdict_case_commit_receipts
        WHERE scorecard_id = $1 AND case_id = $2 AND trial = $3`,
      [receipt.scorecardId, receipt.caseId, receipt.trial],
    );
    const winner = settled[0];
    // Neither inserted nor found even now would mean the row that refused the insert has since vanished, and
    // nothing deletes a receipt — so this is a store fault, not an outcome to interpret. Reporting it as
    // "somebody else committed" would invent a winner nobody can name.
    if (!winner) throw new Error("case receipt claim returned no row — neither inserted nor found");
    return { kind: "already_committed", receipt: toReceipt(winner) };
  }

  async list(scorecardId: string): Promise<CaseCommitReceipt[]> {
    const { rows } = await this.client.query<ReceiptRow>(
      "SELECT * FROM everdict_case_commit_receipts WHERE scorecard_id = $1 ORDER BY case_id, trial",
      [scorecardId],
    );
    return rows.map(toReceipt);
  }
}
