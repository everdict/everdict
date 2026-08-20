import {
  EXECUTING_PREDECESSOR_STATES,
  OPEN_RUN_STATUSES,
  OPEN_SCORECARD_STATUSES,
  TERMINAL_ATTEMPT_STATES,
  TERMINAL_RUN_STATUSES,
  TERMINAL_SCORECARD_STATUSES,
} from "@everdict/contracts";
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
    // Derived from the CONSTANT, not spelled again: the property is that the guard lives in the WHERE clause
    // rather than in a read-then-write, and a hand-copied list turns "the vocabulary grew" into a test failure
    // that says nothing (arch-review 57 added `revoked`, which is terminal for the same reason the others are).
    expect(text).toContain(`state NOT IN (${TERMINAL_ATTEMPT_STATES.map((s) => `'${s}'`).join(", ")})`);
    // …and `executing` is reachable only from the states that PRECEDE running, so a late "compute started"
    // cannot rewind a row. Derived from the constant for the same reason as the line above — and this file is
    // where that lesson had to be learnt twice: the terminal set was already read from contracts while the
    // predecessor set right beside it was spelled by hand, so when arch-review 58 added `active` the twins
    // drifted and this assertion pinned the drift rather than catching it.
    expect(text).toContain(
      `($2 <> 'executing' OR state IN (${EXECUTING_PREDECESSOR_STATES.map((s) => `'${s}'`).join(", ")}))`,
    );
    // The set is a WHITELIST, not a formality: a terminal state may never appear in it.
    expect(EXECUTING_PREDECESSOR_STATES.some((s) => TERMINAL_ATTEMPT_STATES.includes(s))).toBe(false);
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
        ? { rows: [{ runtime_work: null, updated_at: "2026-08-18T00:00:00.000Z", authorized: true }] }
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
    // RESTATED (arch-review 56, Wave A). It read `s.status NOT IN ('succeeded', 'failed')` — the negated form
    // that let a cancelled and a superseded parent through. The vocabulary now comes from the shared
    // allowlist and has its own case above; what this line asserts is that the parent is checked AT ALL.
    expect(text).toContain("s.status IN (");
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

  // ── THE PARENT VOCABULARY IS GENERATED, NOT SPELLED (arch-review 56, Wave A) ──────────────────────
  //
  // The condition shipped as `NOT IN ('succeeded', 'failed')`, which is fail-OPEN: it was true of the enum on
  // the day it was written, and `superseded`/`cancelled` (scorecards) and `suspended` (runs) joined
  // afterwards — so a batch the user had CANCELLED still passed the guard that exists to stop exactly that
  // dispatch. Asserted against the exported allowlists, so the day a status is added the compiler moves the
  // expectation and this test asks whether the SQL followed.
  it("reserveWork names the OPEN parent statuses positively, from the shared allowlist", async () => {
    const { client, calls } = fakeClient((text) =>
      text.startsWith("SELECT")
        ? { rows: [{ runtime_work: null, updated_at: "t", authorized: true }] }
        : { rows: [{ runtime_work: WORK, updated_at: "t" }] },
    );
    await new PgExecutionAttemptStore(client).reserveWork("evd-run-r1#g1", WORK);
    const text = calls[1]?.text ?? "";
    expect(text).toContain(`s.status IN (${OPEN_SCORECARD_STATUSES.map((s) => `'${s}'`).join(", ")})`);
    expect(text).toContain(`r.status IN (${OPEN_RUN_STATUSES.map((s) => `'${s}'`).join(", ")})`);
    // …and the negated form is gone: it is the shape, not the two missing strings, that made this drift.
    expect(text, "the parent guard is still a negated status list").not.toContain("status NOT IN");
    for (const status of [...TERMINAL_SCORECARD_STATUSES, ...TERMINAL_RUN_STATUSES])
      expect(text, `the guard still spells '${status}' by hand`).not.toContain(`'${status}'`);
  });

  it("reserveWork REFUSES when the guarded update matched nothing — ended, taken, or no longer ours", async () => {
    const { client } = fakeClient((text) =>
      text.startsWith("SELECT") ? { rows: [{ runtime_work: null, updated_at: "t", authorized: true }] } : { rows: [] },
    );
    await expect(
      new PgExecutionAttemptStore(client).reserveWork("evd-run-r1#g1", WORK),
      "a dispatch was authorized by an attempt that may no longer place work",
    ).rejects.toThrow(/may no longer authorize work/);
  });

  it("reserveWork is IDEMPOTENT for the same work and REFUSES different work on a taken attempt", async () => {
    // `authorized` is the SAME correlated EXISTS the guarded UPDATE uses, carried on the read (arch-review 56,
    // Wave D). Before it, this path returned a stored intent having asked nothing about the parent.
    const held = { rows: [{ runtime_work: WORK, updated_at: "2026-08-18T00:00:00.000Z", authorized: true }] };
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

  it("reserveWork REFUSES the SAME work once the parent may no longer authorize any", async () => {
    // The lifetime half (arch-review 56, Wave D): between the first reservation and this retry the batch was
    // cancelled, superseded or taken over. Returning the stored intent here handed the backend a capability
    // minted from a memory — and a cancellation that had already converged on "nothing exists under this
    // handle" then watched the job appear.
    const { client } = fakeClient(() => ({
      rows: [{ runtime_work: WORK, updated_at: "2026-08-18T00:00:00.000Z", authorized: false }],
    }));
    await expect(
      new PgExecutionAttemptStore(client).reserveWork("evd-run-r1#g1", WORK),
      "a revoked attempt re-authorized its own work by repeating itself",
    ).rejects.toThrow(/may no longer authorize work/);
  });

  it("carries the authority answer on the idempotency read, from the one predicate", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgExecutionAttemptStore(client).reserveWork("evd-run-r1#g9", WORK).catch(() => undefined);
    // One definition of "may still authorize", used by the read and by the write — they used to be a
    // condition and a shortcut past it.
    expect(calls[0]?.text).toContain("AS authorized");
    expect(calls[0]?.text).toContain(`s.status IN (${OPEN_SCORECARD_STATUSES.map((s) => `'${s}'`).join(", ")})`);
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
