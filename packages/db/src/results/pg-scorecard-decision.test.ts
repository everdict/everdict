import { InMemoryCaseReceiptStore } from "@everdict/application-control";
import type { ScorecardRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgScorecardStore } from "./pg-scorecard-store.js";
import { InMemoryScorecardStore } from "./scorecard-store.js";

// ── THE SETTLE CONDITIONS ON THE RECEIPT COUNT IT READ (review 40, TRUST-175's store half) ───────────
//
// Receipts are insert-only, so the count the settle read is a sound freshness token: a receipt committed
// between the read and the terminal write refuses the settle, and the recorded decision context can never
// describe a ledger the summary was not computed over. Pinned on the SQL text (Pg) and on the paired
// in-memory guard, so the mutation "drop the receipt-count condition" turns the suite red.

const record = (id: string): ScorecardRecord =>
  ({
    id,
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "running",
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  }) as ScorecardRecord;

describe("expectReceiptCount — the receipt-count CAS on the terminal write", () => {
  it("Pg evaluates the count INSIDE the write statement (a read-then-write would be racing again)", async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const client: SqlClient = {
      async query<T>(sql: string, params?: unknown[]) {
        statements.push({ sql, params: params ?? [] });
        return { rows: [] as T[] };
      },
    } as unknown as SqlClient;
    await new PgScorecardStore(client).update("sc-1", { status: "succeeded" }, undefined, {
      expectNonTerminal: true,
      expectReceiptCount: 2,
    });
    const sql = statements[0]?.sql ?? "";
    expect(sql).toContain("SELECT count(*) FROM everdict_case_commit_receipts");
    expect(sql).toContain("r.scorecard_id = everdict_scorecards.id");
    expect(statements[0]?.params).toContain(2);
  });

  it("in memory (paired), a receipt landing after the read refuses the settle; the matching count commits", async () => {
    const receipts = new InMemoryCaseReceiptStore();
    const store = new InMemoryScorecardStore();
    store.attachReceipts((id) => receipts.countFor(id));
    await store.create(record("sc-1"));
    await receipts.commit({
      scorecardId: "sc-1",
      caseId: "c1",
      trial: 0,
      childRunId: "child-A",
      resultDigest: "d",
      committedAt: "2026-08-14T00:00:01.000Z",
    });
    // The settle read count=0 (before the receipt landed) → the write must refuse.
    expect(await store.update("sc-1", { status: "succeeded" }, undefined, { expectReceiptCount: 0 })).toBeUndefined();
    expect((await store.get("sc-1"))?.status).toBe("running"); // untouched
    // The settle that read the ledger as it now is commits.
    const written = await store.update("sc-1", { status: "succeeded" }, undefined, { expectReceiptCount: 1 });
    expect(written?.status).toBe("succeeded");
  });

  it("unpaired, the condition has nothing to evaluate and the write is allowed (the documented dev-store stance)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc-2"));
    const written = await store.update("sc-2", { status: "succeeded" }, undefined, { expectReceiptCount: 5 });
    expect(written?.status).toBe("succeeded");
  });
});
