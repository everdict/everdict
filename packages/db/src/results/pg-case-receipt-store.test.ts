import type { CaseCommitReceipt } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgCaseReceiptStore } from "./pg-case-receipt-store.js";

// Certified in the trust suite (docs/trust-certification.md) as:
//   TRUST-166 — At most one canonical outcome per case
// Named here because the table's last column points at this file, and a row whose test does not say
// which claim it carries leaves the next reader to guess which assertion is load-bearing.
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

  it("persists and reads back the outcome discriminant + lineage (arch-review 42, mig 0181)", async () => {
    const inheritedRow = { ...row, kind: "inherited", source_scorecard_id: "sc-src", inserted: true };
    const { client, statements } = fakeClient([inheritedRow]);
    const out = await new PgCaseReceiptStore(client).commit({
      ...receipt,
      kind: "inherited",
      sourceScorecardId: "sc-src",
    });
    expect(statements[0]?.params).toContain("inherited");
    expect(statements[0]?.params).toContain("sc-src");
    if (out.kind !== "committed") throw new Error("expected committed");
    expect(out.receipt.kind).toBe("inherited");
    expect(out.receipt.sourceScorecardId).toBe("sc-src");
    // …and a pre-discriminant row (NULL kind) reads as absent, never as some invented kind.
    const { client: legacy } = fakeClient([{ ...row, kind: null, source_scorecard_id: null, inserted: false }]);
    const legacyOut = await new PgCaseReceiptStore(legacy).commit(receipt);
    if (legacyOut.kind !== "already_committed") throw new Error("expected already_committed");
    expect(legacyOut.receipt.kind).toBeUndefined();
  });

  it("reports the WINNER's receipt when the insert was refused, never the caller's own", async () => {
    const { client } = fakeClient([{ ...row, child_run_id: "child-A", inserted: false }]);
    const out = await new PgCaseReceiptStore(client).commit({ ...receipt, childRunId: "child-B" });
    expect(out.kind).toBe("already_committed");
    expect(out.receipt.childRunId).toBe("child-A");
  });

  it("reads the winner in a SECOND statement when the claim's own snapshot could not see it", async () => {
    // The multi-process race (TRUST-169) proved this is the ordinary path, not an edge: a data-modifying CTE
    // and the query around it share one snapshot taken before the statement ran, so a loser whose conflict
    // committed after that instant sees no row at all. The follow-up read exists to get a fresh snapshot.
    let call = 0;
    const client = {
      async query<T>(_sql: string, _params?: unknown[]) {
        call += 1;
        const rows = call === 1 ? [] : [{ ...row, child_run_id: "child-A" }];
        return { rows: rows as T[], rowCount: rows.length };
      },
    } as unknown as SqlClient;
    const out = await new PgCaseReceiptStore(client).commit({ ...receipt, childRunId: "child-B" });
    expect(out.kind).toBe("already_committed");
    expect(out.receipt.childRunId).toBe("child-A");
    expect(call).toBe(2);
  });

  it("…and a claim that finds nothing even then is a store fault, not a silent loss", async () => {
    const { client } = fakeClient([]);
    // Nothing deletes a receipt, so "refused by a row that is no longer there" is not an outcome to
    // interpret. Reporting it as "somebody else committed" would invent a winner nobody can name.
    await expect(new PgCaseReceiptStore(client).commit(receipt)).rejects.toThrow(/neither inserted nor found/);
  });
});
