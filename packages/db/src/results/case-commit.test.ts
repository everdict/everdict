import { InMemoryCaseReceiptStore, InMemoryExecutionAttemptStore, type RunStore } from "@everdict/application-control";
import type { CaseCommitReceipt, RunRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgCaseReceiptStore } from "./pg-case-receipt-store.js";
import { InMemoryRunStore } from "./run-store.js";

// ── THE COMMIT POINT IS ONE TRANSACTION (review 40 P0, TRUST-171's unit half) ─────────────────────────
//
// The receipt claim and the child's terminal write are all-or-nothing. As two independent round-trips, a
// claim whose child settle was then refused poisoned the case forever: the claim said "this child is the
// answer" and the child never carried one — the successor's re-drive met `already_committed` naming a
// non-terminal child, permanently. These pin the contract on both adapters: a refused settle persists NO
// receipt, a throwing settle persists NO receipt, and a lost claim never runs the settle at all.

const receipt = (childRunId: string): CaseCommitReceipt => ({
  scorecardId: "sc-1",
  caseId: "c1",
  trial: 0,
  childRunId,
  executionId: "evd-sc-1-c1",
  generation: 1,
  resultDigest: `digest-of-${childRunId}`,
  committedAt: "2026-08-14T00:00:00.000Z",
});

const child = (id: string): RunRecord =>
  ({
    id,
    tenant: "acme",
    harness: { id: "h", version: "1" },
    caseId: "c1",
    status: "running",
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  }) as RunRecord;

describe("InMemoryCaseReceiptStore.commitCase — the claim and the settle are one decision", () => {
  it("a refused settle persists NO receipt — the case stays claimable by whoever holds the authority", async () => {
    const receipts = new InMemoryCaseReceiptStore();
    const runs = new InMemoryRunStore();
    const refused = await receipts.commitCase(receipt("child-A"), async () => undefined, runs);
    expect(refused.kind).toBe("unsettled");
    expect(await receipts.list("sc-1")).toHaveLength(0); // the poison pill this exists to end

    // …and the successor commits normally: the failed claim left nothing behind.
    await runs.create(child("child-B"));
    const won = await receipts.commitCase(
      receipt("child-B"),
      (r) => r.update("child-B", { status: "succeeded", updatedAt: "2026-08-14T00:00:01.000Z" }),
      runs,
    );
    expect(won.kind).toBe("committed");
    expect((await receipts.list("sc-1"))[0]?.childRunId).toBe("child-B");
  });

  it("a settle that THROWS rethrows and persists NO receipt — a store fault is not an outcome", async () => {
    const receipts = new InMemoryCaseReceiptStore();
    const runs = new InMemoryRunStore();
    await expect(
      receipts.commitCase(
        receipt("child-A"),
        async () => {
          throw new Error("store down");
        },
        runs,
      ),
    ).rejects.toThrow("store down");
    expect(await receipts.list("sc-1")).toHaveLength(0);
  });

  it("a lost claim never runs the settle — the loser is told whose case it is and writes nothing", async () => {
    const receipts = new InMemoryCaseReceiptStore();
    const runs = new InMemoryRunStore();
    await runs.create(child("child-A"));
    await receipts.commitCase(
      receipt("child-A"),
      (r) => r.update("child-A", { status: "succeeded", updatedAt: "2026-08-14T00:00:01.000Z" }),
      runs,
    );
    let settleRan = false;
    const lost = await receipts.commitCase(
      receipt("child-B"),
      async () => {
        settleRan = true;
        return undefined;
      },
      runs,
    );
    expect(lost.kind).toBe("already_committed");
    expect(lost.kind === "already_committed" && lost.receipt.childRunId).toBe("child-A");
    expect(settleRan).toBe(false);
  });

  it("two CONCURRENT commits of one case serialize — exactly one wins, the other is told the winner", async () => {
    // The in-memory stand-in for the Pg transaction: without per-key serialization the two interleave across
    // the settle's await and both report committed.
    const receipts = new InMemoryCaseReceiptStore();
    const runs = new InMemoryRunStore();
    await runs.create(child("child-A"));
    await runs.create(child("child-B"));
    const settleOf = (id: string) => (r: RunStore) =>
      r.update(id, { status: "succeeded" as const, updatedAt: "2026-08-14T00:00:01.000Z" });
    const [a, b] = await Promise.all([
      receipts.commitCase(receipt("child-A"), settleOf("child-A"), runs),
      receipts.commitCase(receipt("child-B"), settleOf("child-B"), runs),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["already_committed", "committed"]);
    expect(await receipts.list("sc-1")).toHaveLength(1);
  });
});

describe("InMemoryCaseReceiptStore — the tuple key cannot alias", () => {
  it("ids containing the printable separator do not collapse into one claim", async () => {
    // `("sc a", "b")` vs `("sc", "a b")` — with a space-joined key these spell the SAME string, so the
    // second claim would be told "already committed" about a case in a DIFFERENT scorecard. NUL-joined
    // keys keep the tuple a tuple.
    const receipts = new InMemoryCaseReceiptStore();
    const a = await receipts.commit({ ...receipt("child-A"), scorecardId: "sc a", caseId: "b" });
    const b = await receipts.commit({ ...receipt("child-B"), scorecardId: "sc", caseId: "a b" });
    expect(a.kind).toBe("committed");
    expect(b.kind).toBe("committed");
    expect(await receipts.list("sc a")).toHaveLength(1);
    expect(await receipts.list("sc")).toHaveLength(1);
  });
});

// The Pg twin over a fake SqlClient (the house testing idiom — assert the transactional shape, not a live DB;
// the live race is TRUST-169's, and stays a two-OS-process scenario).
describe("PgCaseReceiptStore.commitCase — BEGIN … claim … settle … COMMIT/ROLLBACK", () => {
  function fakeTxClient(opts: { claimRows: Array<Record<string, unknown>> }) {
    const events: string[] = [];
    const txStatements: Array<{ sql: string; params: unknown[] }> = [];
    const tx: SqlClient = {
      async query<T>(sql: string, params?: unknown[]) {
        txStatements.push({ sql, params: params ?? [] });
        if (sql.includes("INSERT INTO everdict_case_commit_receipts")) return { rows: opts.claimRows as T[] };
        return { rows: [] as T[] };
      },
    } as unknown as SqlClient;
    const client: SqlClient = {
      async query<T>() {
        throw new Error("commitCase must not touch the base client — every statement rides the transaction");
      },
      async transaction<T>(run: (c: SqlClient) => Promise<T>): Promise<T> {
        events.push("BEGIN");
        try {
          const out = await run(tx);
          events.push("COMMIT");
          return out;
        } catch (err) {
          events.push("ROLLBACK");
          throw err;
        }
      },
    } as unknown as SqlClient;
    return { client, events, txStatements };
  }

  const row = {
    scorecard_id: "sc-1",
    case_id: "c1",
    trial: 0,
    child_run_id: "child-A",
    execution_id: "evd-sc-1-c1",
    generation: 1,
    result_digest: "digest-of-child-A",
    judge_closure_digest: null,
    committed_at: "2026-08-14T00:00:00.000Z",
  };

  it("a refused child fence ROLLS BACK the claim — the receipt insert is un-happened, not orphaned", async () => {
    const { client, events } = fakeTxClient({ claimRows: [{ ...row, inserted: true }] });
    const out = await new PgCaseReceiptStore(client).commitCase(
      receipt("child-A"),
      async () => undefined, // the fence said no (takeover / cancel / already terminal)
      new InMemoryRunStore(),
    );
    expect(out.kind).toBe("unsettled");
    expect(events).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("a settled child COMMITS with its claim, and the settle runs on the TRANSACTION's run store", async () => {
    const { client, events, txStatements } = fakeTxClient({ claimRows: [{ ...row, inserted: true }] });
    const out = await new PgCaseReceiptStore(client).commitCase(
      receipt("child-A"),
      async (runs) => {
        // The store handed in is transaction-bound: its writes land in the same BEGIN…COMMIT as the claim.
        await runs.get("child-A"); // any read/write goes to the tx client — asserted below
        return child("child-A");
      },
      new InMemoryRunStore(),
    );
    expect(out.kind).toBe("committed");
    expect(events).toEqual(["BEGIN", "COMMIT"]);
    expect(txStatements.some((s) => s.sql.includes("everdict_runs"))).toBe(true);
  });

  it("a lost claim returns the winner inside the transaction and settles nothing", async () => {
    const { client, events, txStatements } = fakeTxClient({
      claimRows: [{ ...row, child_run_id: "child-other", inserted: false }],
    });
    let settleRan = false;
    const out = await new PgCaseReceiptStore(client).commitCase(
      receipt("child-A"),
      async () => {
        settleRan = true;
        return child("child-A");
      },
      new InMemoryRunStore(),
    );
    expect(out.kind).toBe("already_committed");
    expect(out.kind === "already_committed" && out.receipt.childRunId).toBe("child-other");
    expect(settleRan).toBe(false);
    expect(events).toEqual(["BEGIN", "COMMIT"]);
    expect(txStatements.some((s) => s.sql.includes("everdict_runs"))).toBe(false);
  });

  // ── THE ATTEMPT'S TERMINAL STAMP RIDES THE SAME TRANSACTION (arch-review 43) ──────────────────────────
  //
  // Phase 1 stamped the physical ledger AFTER commitCase resolved, best-effort: a crash in that window left a
  // committed receipt naming an execution whose attempt row still said `created`. These pin the promotion —
  // the stamp is a statement BETWEEN this transaction's BEGIN and COMMIT, and a stamp that throws takes the
  // receipt and the child's write down with it.
  it("the attempt stamp is a statement of the SAME transaction as the claim and the child's write", async () => {
    const { client, events, txStatements } = fakeTxClient({ claimRows: [{ ...row, inserted: true }] });
    const out = await new PgCaseReceiptStore(client).commitCase(
      receipt("child-A"),
      async (runs, attempts) => {
        await runs.update("child-A", { status: "succeeded", updatedAt: "2026-08-14T00:00:01.000Z" });
        // The ledger handed in is transaction-bound too — the base client throws if anything escapes it.
        await attempts?.transition("evd-sc-1-c1#g1", "committed", { childRunId: "child-A" });
        return child("child-A");
      },
      new InMemoryRunStore(),
      // The caller's AMBIENT ledger, which this adapter must ignore exactly as it ignores the ambient run
      // store: a stamp landing there would commit on its own clock, which is the window being closed.
      new InMemoryExecutionAttemptStore(),
    );
    expect(out.kind).toBe("committed");
    expect(events).toEqual(["BEGIN", "COMMIT"]);
    const at = (fragment: string): number => txStatements.findIndex((s) => s.sql.includes(fragment));
    expect(at("INSERT INTO everdict_case_commit_receipts")).toBe(0);
    expect(at("UPDATE everdict_runs")).toBeGreaterThan(at("INSERT INTO everdict_case_commit_receipts"));
    expect(at("UPDATE everdict_execution_attempts")).toBeGreaterThan(at("UPDATE everdict_runs"));
  });

  it("a stamp that THROWS rolls the whole commit back — no receipt for a case the ledger could not record", async () => {
    const { client, events } = fakeTxClient({ claimRows: [{ ...row, inserted: true }] });
    await expect(
      new PgCaseReceiptStore(client).commitCase(
        receipt("child-A"),
        async (runs, attempts) => {
          await runs.update("child-A", { status: "succeeded", updatedAt: "2026-08-14T00:00:01.000Z" });
          if (attempts) throw new Error("attempt ledger down");
          return child("child-A");
        },
        new InMemoryRunStore(),
        new InMemoryExecutionAttemptStore(),
      ),
    ).rejects.toThrow("attempt ledger down");
    // Not `unsettled` — a store fault is reported as one. And the claim is un-happened with it.
    expect(events).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("FAILS CLOSED on a client that cannot open a transaction — never a claim without its settle", async () => {
    const bare: SqlClient = {
      async query<T>() {
        return { rows: [] as T[] };
      },
    } as unknown as SqlClient;
    await expect(
      new PgCaseReceiptStore(bare).commitCase(receipt("child-A"), async () => child("child-A"), new InMemoryRunStore()),
    ).rejects.toThrow(/atomically/);
  });
});
