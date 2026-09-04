import { executionPassAuthority } from "@everdict/application-control";
import type { CaseCommitReceipt, RunRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgCaseReceiptStore } from "./pg-case-receipt-store.js";

// ── THE SHAPE THE ENGINE TAUGHT (docs/architecture/in-place-case-retry-spec.md) ──────────────────────
//
// These pin the superseding statement's TEXT, and the text is not the evidence — the statement was driven
// against a real Postgres 16, which is the only thing that can say a planner accepts it. What a text test
// CAN do is keep a specific, already-paid-for mistake from coming back, and this one is worth pinning:
//
// The first version read the row it was about to replace with `SELECT ... FOR UPDATE` inside a CTE of the
// same statement. That is the obvious way to make a read-then-replace safe, and against a real database it
// made the CTE come back EMPTY every time — a row being updated by the same statement cannot be locked by
// that statement's own CTE, so the lock became a skip. The upsert still moved the pointer, so the outcome
// read `committed` with no displaced receipt: the caller had nothing to preserve, and the supersession
// degraded into the silent edit the whole design exists to refuse. Both spellings pass a text-only test
// that merely looks for the upsert, which is why these two assertions are about what must NOT be there.

// `commitCase` REQUIRES a transaction (`withTransaction` throws on a client that cannot open one), so the
// fake has to provide one — and it hands the SAME recorder back as the transaction-bound twin, which is
// what the in-memory store does for the same reason.
const capture = (): { client: SqlClient; sql: string[] } => {
  const sql: string[] = [];
  const client = {
    async query<T>(text: string) {
      sql.push(text);
      return { rows: [] as T[], rowCount: 0 };
    },
    transaction: <T>(run: (tx: SqlClient) => Promise<T>) => run(client),
  } as unknown as SqlClient;
  return { sql, client };
};

const receipt: CaseCommitReceipt = {
  scorecardId: "sc-1",
  caseId: "c1",
  trial: 0,
  childRunId: "run-2",
  resultDigest: "dig-2",
  committedAt: "2026-09-04T00:00:00.000Z",
};

const authority = executionPassAuthority(
  { id: "sc-1", executionPass: { passId: "p-1", targetRevision: 2, status: "running" } },
  "p-1",
);

describe("PgCaseReceiptStore — the superseding claim", () => {
  const supersedingSql = async (): Promise<string> => {
    const { client, sql } = capture();
    await new PgCaseReceiptStore(client)
      .commitCase(receipt, async () => ({ id: "run-2" }) as RunRecord, {} as never, undefined, undefined, authority)
      .catch(() => undefined); // the fake client returns no rows, so the store throws — the SQL is what we want
    return sql.join("\n");
  };

  it("reads the row it replaces WITHOUT locking it — the lock silently became a skip", async () => {
    const text = await supersedingSql();
    expect(text).toContain("WITH prior AS MATERIALIZED (");
    // The regression marker. Against a real engine this one word emptied `prior`, and every text test that
    // only asserted the upsert stayed green.
    expect(text).not.toContain("FOR UPDATE");
  });

  it("replaces the pointer rather than skipping, and returns the prior row with it", async () => {
    const text = await supersedingSql();
    expect(text).toContain("ON CONFLICT (scorecard_id, case_id, trial) DO UPDATE SET");
    expect(text).toContain("to_jsonb(prior) AS displaced");
  });

  it("takes the DO NOTHING path when no authority is presented — today's behaviour, unchanged", async () => {
    const { client, sql } = capture();
    await new PgCaseReceiptStore(client)
      .commitCase(receipt, async () => ({ id: "run-2" }) as RunRecord, {} as never)
      .catch(() => undefined);
    const text = sql.join("\n");
    expect(text).toContain("ON CONFLICT (scorecard_id, case_id, trial) DO NOTHING");
    // A commit with no authority may not move a pointer, and the statement is where that is true or not.
    expect(text).not.toContain("DO UPDATE SET");
  });
});
