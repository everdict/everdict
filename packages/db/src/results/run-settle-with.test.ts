import { type AttemptStamp, InMemoryExecutionAttemptStore, type RunUpdateGuard } from "@everdict/application-control";
import type { RunRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgRunStore } from "./pg-run-store.js";
import { InMemoryRunStore } from "./run-store.js";

// ── THE STANDALONE LANE'S COMMIT POINT IS ONE TRANSACTION (arch-review 45) ────────────────────────────
//
// A run's terminal write and its physical attempt's terminal stamp are all-or-nothing. As two round-trips
// the window between them published a SUCCEEDED run — completion fact, callback and all — whose attempt row
// still said `created`: a ledger that never saw the execution it records end. These pin the contract on both
// adapters: the stamp is a statement of the SAME transaction, a stamp that throws takes the terminal write
// with it, and a REFUSED fence stamps nothing while rolling nothing back (the loser wrote nothing to undo).

const ROW = {
  id: "r1",
  tenant: "acme",
  harness_id: "scripted",
  harness_version: "0",
  case_id: "c1",
  status: "succeeded",
  result: null,
  error: null,
  created_at: new Date("2026-08-14T00:00:00.000Z"),
  updated_at: new Date("2026-08-14T00:00:01.000Z"),
};

const TERMINAL: Partial<RunRecord> = { status: "succeeded", updatedAt: "2026-08-14T00:00:01.000Z" };
const FENCE: RunUpdateGuard = { expectNonTerminal: true, expectOwnerEpoch: 3 };

// The stamp a standalone finalize offers: the attempt's terminal state, applied through whichever ledger the
// store hands it (the transaction's twin where one exists).
function stampOf(
  attempts: InMemoryExecutionAttemptStore,
  attemptId: string,
  opts?: { throws?: boolean; seen?: string[] },
): AttemptStamp {
  return {
    attempts,
    apply: async (bound) => {
      opts?.seen?.push("stamp");
      if (opts?.throws) throw new Error("attempt ledger down");
      await bound.transition(attemptId, "committed", { childRunId: "r1" });
    },
  };
}

describe("PgRunStore.settleWith — BEGIN … terminal write … attempt stamp … COMMIT/ROLLBACK", () => {
  function fakeTxClient(opts?: { updateRows?: unknown[] }) {
    const events: string[] = [];
    const txStatements: Array<{ sql: string; params: unknown[] }> = [];
    const tx: SqlClient = {
      async query<T>(sql: string, params?: unknown[]) {
        txStatements.push({ sql, params: params ?? [] });
        if (sql.includes("everdict_runs")) return { rows: (opts?.updateRows ?? [ROW]) as T[] };
        return { rows: [] as T[] };
      },
    } as unknown as SqlClient;
    const client: SqlClient = {
      async query<T>() {
        throw new Error("settleWith must not touch the base client — every statement rides the transaction");
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

  it("stamps the attempt inside the SAME transaction as the terminal write, and after it", async () => {
    const { client, events, txStatements } = fakeTxClient();
    const settled = await new PgRunStore(client).settleWith(
      "r1",
      TERMINAL,
      undefined,
      FENCE,
      // The AMBIENT ledger, which this adapter must ignore exactly as `commitCase` ignores the ambient run
      // store: a stamp landing there would commit on its own clock, which is the window being closed.
      stampOf(new InMemoryExecutionAttemptStore(), "evd-run-r1#g1"),
    );
    expect(settled?.status).toBe("succeeded");
    expect(events).toEqual(["BEGIN", "COMMIT"]);
    const at = (fragment: string): number => txStatements.findIndex((s) => s.sql.includes(fragment));
    // AFTER the settle, never before: a refused fence must not have said "committed" about an attempt whose
    // run it never settled.
    expect(at("UPDATE everdict_runs")).toBe(0);
    expect(at("UPDATE everdict_execution_attempts")).toBeGreaterThan(at("UPDATE everdict_runs"));
  });

  it("a stamp that THROWS rolls the terminal write back — no settled run behind a row the ledger could not write", async () => {
    const { client, events, txStatements } = fakeTxClient();
    await expect(
      new PgRunStore(client).settleWith(
        "r1",
        TERMINAL,
        undefined,
        FENCE,
        stampOf(new InMemoryExecutionAttemptStore(), "evd-run-r1#g1", { throws: true }),
      ),
    ).rejects.toThrow("attempt ledger down");
    // The run's terminal write was attempted and un-happened with the stamp — the run stays open, which is
    // the state boot recovery re-drives.
    expect(txStatements.some((s) => s.sql.includes("UPDATE everdict_runs"))).toBe(true);
    expect(events).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("a REFUSED fence stamps nothing and rolls nothing back — the loser wrote nothing to undo", async () => {
    const seen: string[] = [];
    const { client, events, txStatements } = fakeTxClient({ updateRows: [] });
    const settled = await new PgRunStore(client).settleWith(
      "r1",
      TERMINAL,
      undefined,
      FENCE,
      stampOf(new InMemoryExecutionAttemptStore(), "evd-run-r1#g1", { seen }),
    );
    expect(settled).toBeUndefined();
    expect(seen).toEqual([]); // the attempt that LOST is superseded by its caller, never committed here
    expect(txStatements.some((s) => s.sql.includes("everdict_execution_attempts"))).toBe(false);
    expect(events).toEqual(["BEGIN", "COMMIT"]); // no rollback poison for a write that never landed
  });

  it("commits under the SAME fence the ordinary settlement does — one condition, not a second spelling", async () => {
    // The defect this forecloses: an atomic path that re-expresses the guard drifts from `update`, and the
    // drift is invisible until a displaced driver's settlement passes the fence only on the new path.
    const plain: Array<{ sql: string; params: unknown[] }> = [];
    const bare: SqlClient = {
      async query<T>(sql: string, params?: unknown[]) {
        plain.push({ sql, params: params ?? [] });
        return { rows: [ROW] as T[] };
      },
    } as unknown as SqlClient;
    await new PgRunStore(bare).update("r1", TERMINAL, undefined, FENCE);

    const { client, txStatements } = fakeTxClient();
    await new PgRunStore(client).settleWith(
      "r1",
      TERMINAL,
      undefined,
      FENCE,
      stampOf(new InMemoryExecutionAttemptStore(), "evd-run-r1#g1"),
    );
    expect(txStatements[0]?.sql).toBe(plain[0]?.sql);
    expect(txStatements[0]?.params).toEqual(plain[0]?.params);
  });

  it("FAILS CLOSED on a client that cannot open a transaction — never a settlement without its stamp", async () => {
    const bare: SqlClient = {
      async query<T>() {
        return { rows: [ROW] as T[] };
      },
    } as unknown as SqlClient;
    await expect(
      new PgRunStore(bare).settleWith(
        "r1",
        TERMINAL,
        undefined,
        FENCE,
        stampOf(new InMemoryExecutionAttemptStore(), "evd-run-r1#g1"),
      ),
    ).rejects.toThrow(/atomically/);
  });
});

describe("InMemoryRunStore.settleWith — the ordering and the refusal, without the rollback", () => {
  const queued = (id: string): RunRecord =>
    ({
      id,
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      caseId: "c1",
      status: "running",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    }) as RunRecord;

  it("stamps the attempt only after a settlement that COMMITTED", async () => {
    const runs = new InMemoryRunStore();
    const attempts = new InMemoryExecutionAttemptStore();
    await runs.create(queued("r1"));
    const { attemptId } = await attempts.open({ executionId: "evd-run-r1", tenant: "acme", childRunId: "r1" });
    const settled = await runs.settleWith(
      "r1",
      TERMINAL,
      undefined,
      { expectNonTerminal: true },
      {
        attempts,
        apply: async (bound) => {
          // The run is already terminal by the time the stamp runs — the settle goes first, exactly as it does
          // inside the Pg transaction.
          expect((await runs.get("r1"))?.status).toBe("succeeded");
          await bound.transition(attemptId, "committed", { childRunId: "r1" });
        },
      },
    );
    expect(settled?.status).toBe("succeeded");
    expect((await attempts.list("evd-run-r1")).map((a) => a.state)).toEqual(["committed"]);
  });

  it("a refused fence runs no stamp — the attempt that lost is not the one that committed", async () => {
    const runs = new InMemoryRunStore();
    const attempts = new InMemoryExecutionAttemptStore();
    await runs.create({ ...queued("r1"), status: "succeeded" }); // somebody else settled it first
    const { attemptId } = await attempts.open({ executionId: "evd-run-r1", tenant: "acme", childRunId: "r1" });
    let stamped = false;
    const settled = await runs.settleWith(
      "r1",
      { status: "failed" },
      undefined,
      { expectNonTerminal: true },
      {
        attempts,
        apply: async () => {
          stamped = true;
        },
      },
    );
    expect(settled).toBeUndefined();
    expect(stamped).toBe(false);
    expect((await attempts.list("evd-run-r1"))[0]?.state).toBe("created");
    expect(attemptId).toBe("evd-run-r1#g1");
  });
});
