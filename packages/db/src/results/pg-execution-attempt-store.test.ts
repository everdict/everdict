import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgExecutionAttemptStore } from "./pg-execution-attempt-store.js";

function fakeClient(handler: (text: string, params?: unknown[]) => { rows: unknown[] }): {
  client: SqlClient;
  calls: Array<{ text: string; params?: unknown[] }>;
} {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client: SqlClient = {
    async query(text, params) {
      calls.push({ text, params });
      return handler(text, params) as { rows: never[] };
    },
  };
  return { client, calls };
}

describe("PgExecutionAttemptStore", () => {
  it("open computes AND claims the ordinal in ONE statement", async () => {
    // Given the execution already has attempts
    const { client, calls } = fakeClient(() => ({ rows: [{ attempt_id: "evd-sc1-c1#g3", generation: 3 }] }));
    const store = new PgExecutionAttemptStore(client);

    const opened = await store.open({
      executionId: "evd-sc1-c1",
      tenant: "acme",
      scorecardId: "sc1",
      caseId: "c1",
      trial: 0,
      driverEpoch: 4,
    });

    // Then the next ordinal is computed and claimed together — a mint that reads first is not a mint, and
    // two concurrent openers would otherwise read the same MAX and both insert it.
    expect(opened).toEqual({ attemptId: "evd-sc1-c1#g3", generation: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("INSERT INTO everdict_execution_attempts");
    expect(calls[0]?.text).toContain("COALESCE(MAX(generation), 0) + 1");
    expect(calls[0]?.text).toContain("'created'");
    expect(calls[0]?.params).toEqual(["evd-sc1-c1", "acme", "sc1", "c1", 0, null, 4]);
  });

  it("open retries ONCE on the unique violation a concurrent opener causes, and no further", async () => {
    // Given the first insert loses the race (23505) and the second wins
    let attempt = 0;
    const { client, calls } = fakeClient(() => {
      attempt += 1;
      if (attempt === 1) {
        const err: Error & { code?: string } = new Error("duplicate key");
        err.code = "23505";
        throw err;
      }
      return { rows: [{ attempt_id: "evd-run-1#g2", generation: 2 }] };
    });

    expect(await new PgExecutionAttemptStore(client).open({ executionId: "evd-run-1", tenant: "acme" })).toEqual({
      attemptId: "evd-run-1#g2",
      generation: 2,
    });
    expect(calls).toHaveLength(2);
  });

  it("open surfaces a SECOND collision as a fault instead of looping", async () => {
    // A second collision is not a race any more — quietly retrying forever would turn a store fault into an
    // unbounded one.
    const { client } = fakeClient(() => {
      const err: Error & { code?: string } = new Error("duplicate key");
      err.code = "23505";
      throw err;
    });
    await expect(
      new PgExecutionAttemptStore(client).open({ executionId: "evd-run-1", tenant: "acme" }),
    ).rejects.toThrow("duplicate key");
  });

  it("open REFUSES to invent an ordinal when the insert came back empty", async () => {
    // Nothing deletes attempts, so an insert returning no row is a store fault, not a number to make up.
    const { client } = fakeClient(() => ({ rows: [] }));
    await expect(
      new PgExecutionAttemptStore(client).open({ executionId: "evd-run-1", tenant: "acme" }),
    ).rejects.toThrow("was not opened");
  });

  it("transition excludes every terminal state in its WHERE — first terminal wins, in SQL", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [{ attempt_id: "evd-run-1#g1" }] }));
    const store = new PgExecutionAttemptStore(client);

    expect(await store.transition("evd-run-1#g1", "committed", { childRunId: "run-1" })).toBe(true);

    const text = calls[0]?.text ?? "";
    expect(text).toContain("UPDATE everdict_execution_attempts");
    // The guard is the WHERE clause, not a read-then-write: a row that already ended is not matched at all.
    expect(text).toContain("state NOT IN ('committed', 'superseded', 'failed')");
    // …and `executing` is reachable only from `created`, so a late "compute started" cannot rewind a row.
    expect(text).toContain("($2 <> 'executing' OR state = 'created')");
    expect(calls[0]?.params).toEqual(["evd-run-1#g1", "committed", "run-1", null, null, null]);
  });

  it("transition reports a refused write as false rather than throwing", async () => {
    // No row matched — the ordinary shape (a superseded attempt's late report), and the caller's answer to it
    // is nothing at all.
    const { client } = fakeClient(() => ({ rows: [] }));
    expect(await new PgExecutionAttemptStore(client).transition("evd-run-1#g1", "superseded")).toBe(false);
  });

  it("transition leaves unpatched columns alone (COALESCE, not overwrite-with-null)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [{ attempt_id: "evd-run-1#g1" }] }));
    await new PgExecutionAttemptStore(client).transition("evd-run-1#g1", "failed", {
      error: { code: "INTERNAL", message: "boom" },
    });
    // A terminal stamp that carries only an error must not erase the child run id an earlier transition set.
    expect(calls[0]?.text).toContain("child_run_id = COALESCE($3, child_run_id)");
    expect(calls[0]?.params?.[5]).toBe(JSON.stringify({ code: "INTERNAL", message: "boom" }));
  });

  it("markUnisolated is unconditional — a fence that could not be raised is recorded whenever it is learned", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgExecutionAttemptStore(client).markUnisolated("evd-run-1#g1");
    expect(calls[0]?.text).toContain("SET unisolated = true");
    expect(calls[0]?.text).not.toContain("state"); // no state condition: it says nothing about where the attempt is
    expect(calls[0]?.params).toEqual(["evd-run-1#g1"]);
  });

  it("list reads one execution's attempts oldest-first; listForScorecard reads a whole batch's", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    const store = new PgExecutionAttemptStore(client);
    await store.list("evd-run-1");
    await store.listForScorecard("sc1");
    expect(calls[0]?.text).toContain("WHERE execution_id = $1 ORDER BY generation");
    expect(calls[1]?.text).toContain("WHERE scorecard_id = $1 ORDER BY execution_id, generation");
  });
});
