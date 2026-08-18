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
    // `executing` may follow a RESERVATION as well as a bare `created` (arch-review 55, Wave 1): a managed
    // dispatch authorizes its work first, so the row it starts from is the one the reservation transitioned.
    expect(text).toContain("($2 <> 'executing' OR state IN ('created', 'reserved'))");
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

  // ── WHERE THE COMPUTE WILL BE (arch-review 52 Wave 2; the proof is arch-review 54 Phase 1) ─────────
  const WORK = {
    tenant: "acme",
    runtimeId: "nomad-1",
    runId: "evd-run-r1",
    externalJobId: "everdict-c1-evd-run-r1-aaaaa",
    namespace: "everdict-acme",
  };

  it("reserveWork is a CONDITIONAL transition — state, prior reservation and parent authority in one statement", async () => {
    const { client, calls } = fakeClient((text) =>
      text.startsWith("SELECT")
        ? { rows: [{ runtime_work: null, updated_at: "2026-08-18T00:00:00.000Z" }] }
        : { rows: [{ runtime_work: WORK, updated_at: "2026-08-18T00:00:00.000Z" }] },
    );
    const store = new PgExecutionAttemptStore(client);

    const intent = await store.reserveWork("evd-run-r1#g1", WORK);

    // RESTATED (arch-review 55, Wave 1). It read "stamps the handle unconditionally — a terminal row must
    // still be able to take it", and asserted `not.toContain("state")`. That was true while the stamp ran
    // AFTER the apply; once it moved before, unconditional meant a superseded attempt, a displaced driver and
    // a cancelled batch could all authorize new compute.
    const text = calls[1]?.text ?? "";
    expect(text).toContain("UPDATE everdict_execution_attempts");
    expect(text).toContain("runtime_work = $2::jsonb");
    expect(text).toContain("state = 'reserved'");
    // The guard is the WHERE clause, so there is no window between checking authority and taking it.
    expect(text).toContain("a.state = 'created'");
    expect(text).toContain("a.runtime_work IS NULL");
    expect(text).toContain("s.status NOT IN ('succeeded', 'failed')");
    expect(text).toContain("s.owner_epoch = a.driver_epoch");
    expect(text).toContain("r.owner_epoch = a.driver_epoch");
    expect(text).toContain("RETURNING");
    expect(calls[1]?.params?.[0]).toBe("evd-run-r1#g1");
    expect(JSON.parse(String(calls[1]?.params?.[1]))).toMatchObject({
      externalJobId: "everdict-c1-evd-run-r1-aaaaa",
      namespace: "everdict-acme",
      runId: "evd-run-r1",
    });
    // The proof is read back from the write, not echoed from the argument.
    expect(intent).toMatchObject({ attemptId: "evd-run-r1#g1", persistedAt: "2026-08-18T00:00:00.000Z" });
    expect(intent.work.externalJobId).toBe("everdict-c1-evd-run-r1-aaaaa");
  });

  it("reserveWork REFUSES when the guarded update matched nothing — ended, taken, or no longer ours", async () => {
    const { client } = fakeClient((text) =>
      text.startsWith("SELECT") ? { rows: [{ runtime_work: null, updated_at: "t" }] } : { rows: [] },
    );
    await expect(
      new PgExecutionAttemptStore(client).reserveWork("evd-run-r1#g1", WORK),
      "a dispatch was authorized by an attempt that may no longer place work",
    ).rejects.toThrow(/may no longer authorize work/);
  });

  it("reserveWork is IDEMPOTENT for the same work and REFUSES different work on a taken attempt", async () => {
    const held = { rows: [{ runtime_work: WORK, updated_at: "2026-08-18T00:00:00.000Z" }] };
    const same = fakeClient(() => held);
    const again = await new PgExecutionAttemptStore(same.client).reserveWork("evd-run-r1#g1", WORK);
    expect(again.work.externalJobId).toBe(WORK.externalJobId);
    expect(same.calls).toHaveLength(1); // the SELECT answered it; no UPDATE was attempted

    const other = fakeClient(() => held);
    await expect(
      new PgExecutionAttemptStore(other.client).reserveWork("evd-run-r1#g1", { ...WORK, externalJobId: "other" }),
      "a second reservation overwrote the handle of work that is still running",
    ).rejects.toThrow(/already authorized other work/);
  });

  it("reserveWork REFUSES when the update matched no row — an attempt id that names nothing", async () => {
    // The interleaving this closes: a managed dispatch whose ledger row was never opened (or was swept)
    // reserved against a phantom id, the write silently matched nothing, the hook resolved, and the backend
    // created a Job that no teardown, recovery or cancellation could ever name.
    const { client } = fakeClient(() => ({ rows: [] }));
    const store = new PgExecutionAttemptStore(client);
    await expect(
      store.reserveWork("evd-run-r1#g9", WORK),
      "an UPDATE that matched no row reported success to the caller that was about to create cluster work",
    ).rejects.toThrow(/does not exist/);
  });
});
