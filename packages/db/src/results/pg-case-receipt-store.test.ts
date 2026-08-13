import type { CaseCommitReceipt } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgCaseReceiptStore } from "./pg-case-receipt-store.js";

// The store is one statement, so what a unit can pin is that the CLAIM and the read of the winner happen
// inside it — a two-statement version (insert, then select on conflict) is exactly the race the receipt
// exists to end.
function fakeClient(rows: Array<Record<string, unknown>>) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client: SqlClient = {
    async query<T>(sql: string, params?: unknown[]) {
      statements.push({ sql, params: params ?? [] });
      return { rows: rows as T[], rowCount: rows.length };
    },
  } as unknown as SqlClient;
  return { client, statements };
}

const receipt: CaseCommitReceipt = {
  scorecardId: "sc-1",
  caseId: "c1",
  trial: 0,
  childRunId: "child-A",
  executionId: "evd-sc-1-c1",
  generation: 1,
  resultDigest: "sha256:abc",
  committedAt: "2026-08-14T00:00:00.000Z",
};

const row = {
  scorecard_id: "sc-1",
  case_id: "c1",
  trial: 0,
  child_run_id: "child-A",
  execution_id: "evd-sc-1-c1",
  generation: 1,
  result_digest: "sha256:abc",
  judge_closure_digest: null,
  committed_at: "2026-08-14T00:00:00.000Z",
};

describe("PgCaseReceiptStore — the claim is the constraint", () => {
  it("claims and reads the winner in ONE statement — a read-then-insert would be racing again", async () => {
    const { client, statements } = fakeClient([{ ...row, inserted: true }]);
    const out = await new PgCaseReceiptStore(client).commit(receipt);
    expect(out.kind).toBe("committed");
    expect(statements).toHaveLength(1);
    const sql = statements[0]?.sql ?? "";
    expect(sql).toContain("ON CONFLICT (scorecard_id, case_id, trial) DO NOTHING");
    expect(sql).toContain("UNION ALL"); // the loser's read of the winner, in the same statement
  });

  it("reports the WINNER's receipt when the insert was refused, never the caller's own", async () => {
    const { client } = fakeClient([{ ...row, child_run_id: "child-A", inserted: false }]);
    const out = await new PgCaseReceiptStore(client).commit({ ...receipt, childRunId: "child-B" });
    expect(out.kind).toBe("already_committed");
    expect(out.receipt.childRunId).toBe("child-A");
  });

  it("a claim that returns nothing is a store fault, not a silent loss", async () => {
    const { client } = fakeClient([]);
    // Neither inserted nor found is impossible under the primary key — reporting it as "somebody else
    // committed" would invent a winner and hand this attempt's evidence to nobody.
    await expect(new PgCaseReceiptStore(client).commit(receipt)).rejects.toThrow(/neither inserted nor found/);
  });
});
