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

  // ONE STATEMENT, because a claim that reads first is not a claim (the same lesson every terminal write here
  // has already learned). `ON CONFLICT DO NOTHING` combined with a UNION over the existing row means the
  // caller always gets back the receipt that OWNS the case — its own when it won, the winner's when it lost —
  // without a second round trip that another attempt could slip through.
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
    // No row at all can only mean the insert was refused AND the conflicting row vanished between the two
    // halves of one statement, which the primary key makes impossible — so this is a store fault, not an
    // outcome to interpret. Reporting it as "somebody else committed" would invent a winner.
    if (!row) throw new Error("case receipt claim returned no row — neither inserted nor found");
    return { kind: row.inserted ? "committed" : "already_committed", receipt: toReceipt(row) };
  }

  async list(scorecardId: string): Promise<CaseCommitReceipt[]> {
    const { rows } = await this.client.query<ReceiptRow>(
      "SELECT * FROM everdict_case_commit_receipts WHERE scorecard_id = $1 ORDER BY case_id, trial",
      [scorecardId],
    );
    return rows.map(toReceipt);
  }
}
