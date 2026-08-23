import type { ClaimAttemptMint } from "@everdict/application-control";
import { runExecutionId } from "@everdict/contracts";
import type { CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgRunnerJobStore } from "./runner-job-store.js";

// ── THE MUTATION GATE FOR THE RESULT-WIRE FENCE (review 40, TRUST-173's SQL half) ────────────────────
//
// The fence lives in the WHERE clause: every runner-initiated mutation is conditioned on
// `status = 'leased' AND leased_by = <runner> AND lease_epoch = <epoch>`. Removing any predicate compiles,
// passes every in-memory test that never constructs the race, and silently reopens the takeover: a paused
// runner's late submit becomes the canonical completion again. These tests pin the SQL TEXT itself — the
// house fake-SqlClient idiom — so the mutation "drop the epoch condition" turns the suite red instead of
// shipping.

const result: CaseResult = {
  caseId: "c1",
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: [],
};

function capture() {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client: SqlClient = {
    async query<T>(sql: string, params?: unknown[]) {
      statements.push({ sql, params: params ?? [] });
      return { rows: [] as T[] };
    },
  } as unknown as SqlClient;
  return { client, statements };
}

const FENCE = [/status = 'leased'/, /leased_by = \$\d/, /lease_epoch = \$\d/];
// touch() alone answers a swept terminal-cancelled holder too (its reply is the abort channel) — its
// status predicate is wider than the mutation fence's, deliberately (arch-review 47 P1-2).
const TOUCH_FENCE = [/status IN \('leased', 'cancelled'\)/, /leased_by = \$\d/, /lease_epoch = \$\d/];

describe("PgRunnerJobStore — every runner-initiated mutation carries the current-lease fence", () => {
  it("complete() refuses anything but the CURRENT lease in the statement itself", async () => {
    const { client, statements } = capture();
    await new PgRunnerJobStore(client).complete("j1", result, "runner-1", 3);
    const sql = statements[0]?.sql ?? "";
    for (const predicate of FENCE) expect(sql).toMatch(predicate);
    expect(sql).not.toMatch(/status IN \('queued'/); // a requeued job's previous holder has no further right
  });

  it("fail() carries the same fence — a stale holder cannot end a healthy attempt", async () => {
    const { client, statements } = capture();
    await new PgRunnerJobStore(client).fail("j1", "late failure", "runner-1", 3);
    const sql = statements[0]?.sql ?? "";
    for (const predicate of FENCE) expect(sql).toMatch(predicate);
  });

  it("touch() extends only the caller's own live lease — a stale heartbeat resurrects nothing", async () => {
    const { client, statements } = capture();
    await new PgRunnerJobStore(client).touch("j1", "runner-1", 3, 1_000);
    const sql = statements[0]?.sql ?? "";
    for (const predicate of TOUCH_FENCE) expect(sql).toMatch(predicate);
  });

  it("authorize() reads through the identical predicate — the evidence fence and the result fence are one", async () => {
    const { client, statements } = capture();
    await new PgRunnerJobStore(client).authorize("j1", "runner-1", 3);
    const sql = statements[0]?.sql ?? "";
    for (const predicate of FENCE) expect(sql).toMatch(predicate);
  });
});

// ── AND CANCELLATION REVOKES THAT LEASE (arch-review 46, the SQL half) ───────────────────────────────
//
// `cancel_requested` used to be a column the heartbeat READ and no statement obeyed: the claim handed a
// cancelled job straight back to a runner, and its holder could still authorize evidence and land a result —
// which `outcome` then reported as "completed", erasing the cancellation from the record. Dropping any of
// these predicates compiles and passes every test that never cancels mid-lease, so the text is pinned here.
const REVOKED = /NOT cancel_requested/;

// ── THE PARK RECORDS WHICH ATTEMPT IT PARKED (arch-review 51) ───────────────────────────────────────
//
// `current_attempt_id` (mig 0183) is how the attempt a job is CURRENTLY running reaches the replica that
// later re-leases it — the claim reads it as the predecessor to supersede. It was written only by a
// re-lease's own mint, so on the first re-lease the column was NULL: the dispatch's attempt was superseded
// by nobody and stayed `executing` for ever. A park that drops the column compiles and passes every
// single-replica test, so the INSERT's text is pinned here.
describe("PgRunnerJobStore — park writes the dispatch's attempt onto the row", () => {
  it("carries current_attempt_id in the INSERT, so the first re-lease has a predecessor to end", async () => {
    const { client, statements } = capture();
    await new PgRunnerJobStore(client).park({
      jobId: "j1",
      owner: "u-alice",
      runnerId: "laptop",
      job: {
        evalCase: { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
      } as never,
      requiredCaps: [],
      now: 1_000,
      attemptId: "evd-run-1#g1",
    });
    const parked = statements[0];
    expect(parked?.sql).toMatch(/INSERT INTO everdict_runner_jobs \([^)]*current_attempt_id/);
    expect(parked?.params).toContain("evd-run-1#g1");
  });

  it("writes NULL when the dispatch opened no attempt — a composition with no ledger parks as it always did", async () => {
    const { client, statements } = capture();
    await new PgRunnerJobStore(client).park({
      jobId: "j2",
      owner: "u-alice",
      runnerId: "laptop",
      job: {
        evalCase: { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
      } as never,
      requiredCaps: [],
      now: 1_000,
    });
    expect(statements[0]?.params.at(-1)).toBeNull();
  });
});

describe("PgRunnerJobStore — a cancelled job is revoked in the statement, not merely flagged", () => {
  it("claim() neither requeues nor takes a cancelled job — and TERMINALIZES a cancelled expired lease (arch-review 47 P1-2)", async () => {
    const { client, statements } = capture();
    await new PgRunnerJobStore(client).claim({ owner: "u1", runnerId: "runner-1", leaseTtlMs: 1_000, now: 1_000 });
    expect(statements).toHaveLength(3);
    expect(statements[0]?.sql ?? "").toMatch(REVOKED); // the expired-lease requeue skips cancelled work
    // …which used to leave a cancelled expired lease in LIMBO (excluded from requeue AND claim, ended by
    // nothing): the sweep now terminalizes it in its own statement.
    expect(statements[1]?.sql ?? "").toMatch(/SET status = 'cancelled'/);
    expect(statements[1]?.sql ?? "").toMatch(/cancel_requested/);
    expect(statements[2]?.sql ?? "").toMatch(REVOKED); // the candidate SELECT
  });

  it("complete(), fail(), authorize() and restampJob() all require the job not to be cancelled", async () => {
    const { client, statements } = capture();
    const store = new PgRunnerJobStore(client);
    await store.complete("j1", result, "runner-1", 3);
    await store.fail("j1", "late failure", "runner-1", 3);
    await store.authorize("j1", "runner-1", 3);
    await store.restampJob("j1", "runner-1", 3, {
      evalCase: {
        id: "c1",
        env: { kind: "repo", source: { files: {} } },
        task: "t",
        graders: [],
        timeoutSec: 60,
        tags: [],
      },
      harness: { id: "h", version: "1" },
    });
    // complete() and fail() each issue TWO statements against this empty fixture: the revoked write, then
    // the refused holder's ACK (a cancelled lease terminalizes on its own report — arch-review 47 P1-2).
    expect(statements).toHaveLength(6);
    const writes = [statements[0], statements[2], statements[4], statements[5]];
    for (const s of writes) expect(s?.sql ?? "").toMatch(REVOKED);
    for (const ack of [statements[1], statements[3]]) {
      expect(ack?.sql ?? "").toMatch(/SET status = 'cancelled'/);
      expect(ack?.sql ?? "").toMatch(/AND cancel_requested/);
    }
  });

  it("touch() is the deliberate exception — it reports the cancel but freezes the activity clock", async () => {
    const { client, statements } = capture();
    await new PgRunnerJobStore(client).touch("j1", "runner-1", 3, 1_000);
    const sql = statements[0]?.sql ?? "";
    // Not gated: the reply is how the runner is TOLD to abort, so it has to reach a cancelled holder…
    expect(sql).not.toMatch(REVOKED);
    expect(sql).toMatch(/RETURNING cancel_requested/);
    // …but the renewal stops, so a runner that ignores the signal is reclaimed by the idle-timeout path.
    expect(sql).toMatch(/CASE WHEN cancel_requested OR status = 'cancelled' THEN activity_at ELSE to_timestamp/);
  });
});

// ── THE CLAIM AND ITS ATTEMPT ARE ONE TRANSACTION (arch-review 47 §5.1, the SQL half) ────────────────
//
// `claimAttempt` is only worth having if every statement it names lands inside ONE transaction: the claim, the
// predecessor's supersede, the successor's insert, its `executing` stamp, and the row's job + current_attempt_id
// restamp. Drop the transaction and each one still runs, each one still passes every behavioural test — and the
// three windows the design exists to close are all back open (a lease with no attempt row, an attempt row with
// no lease, a predecessor nobody ends). So the BEGIN…COMMIT bracket and the order inside it are pinned here.

const CLAIMED_JOB = {
  evalCase: {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
  },
  harness: { id: "h", version: "1" },
  tenant: "acme",
  runId: "evd-run-1",
};

// A fake that can transact: BEGIN/COMMIT/ROLLBACK are recorded as statements of their own, so the bracket is
// visible in the same list as the writes it is supposed to contain.
function transactional(rowsFor: (sql: string) => unknown[]) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const query = async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params: params ?? [] });
    return { rows: rowsFor(sql) };
  };
  const inner = { query } as unknown as SqlClient;
  const client = {
    query,
    async transaction<T>(run: (tx: SqlClient) => Promise<T>): Promise<T> {
      statements.push({ sql: "BEGIN", params: [] });
      try {
        const out = await run(inner);
        statements.push({ sql: "COMMIT", params: [] });
        return out;
      } catch (err) {
        statements.push({ sql: "ROLLBACK", params: [] });
        throw err;
      }
    },
  } as unknown as SqlClient;
  return { client, statements };
}

// The row a re-lease claims: epoch 2, and it already names the attempt the FIRST lease opened.
const reLeaseRows = (sql: string): unknown[] => {
  if (sql.includes("RETURNING job_id, job, lease_epoch, current_attempt_id"))
    return [{ job_id: "j1", job: CLAIMED_JOB, lease_epoch: 2, current_attempt_id: "evd-run-1#g1" }];
  if (sql.includes("INSERT INTO everdict_execution_attempts")) return [{ attempt_id: "evd-run-1#g2", generation: 2 }];
  return [];
};

// The composition's claim-lane mint, in miniature — it writes through the ledger the STORE hands it, which is
// the whole point: those writes have to land on the claim's own transaction.
const mint: ClaimAttemptMint = async (claimed, ledger) => {
  const attempts = ledger.attempts;
  if (!attempts) throw new Error("the Pg store binds a transaction-bound ledger");
  if (ledger.prior !== undefined)
    await attempts.transition(ledger.prior, "superseded", {
      error: { code: "LEASE_SUPERSEDED", message: "re-leased to another runner" },
    });
  const opened = await attempts.open({ executionId: runExecutionId("1"), tenant: "acme" });
  await attempts.transition(opened.attemptId, "executing", { leaseEpoch: claimed.leaseEpoch });
  return { job: { ...claimed.job, recordingGeneration: opened.generation }, attemptId: opened.attemptId };
};

describe("PgRunnerJobStore — claimAttempt commits the lease and its attempt together", () => {
  it("brackets claim → supersede → insert → executing → restamp in ONE transaction, in that order", async () => {
    const { client, statements } = transactional(reLeaseRows);
    const lease = await new PgRunnerJobStore(client).claimAttempt(
      { owner: "u1", runnerId: "runner-1", leaseTtlMs: 1_000, now: 1_000 },
      mint,
    );
    const sql = statements.map((s) => s.sql);
    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT"); // nothing escapes the bracket — no statement runs after the commit
    // The claim's own three statements are the SAME ones the fenced path runs (they are shared, not forked):
    // the expired-lease requeue, the cancelled sweep, then the candidate UPDATE — which now also brings back
    // the attempt the row names, the one thing no replica could otherwise learn.
    expect(sql[1]).toMatch(/SET status = 'queued'/);
    expect(sql[2]).toMatch(/SET status = 'cancelled'/);
    expect(sql[3]).toMatch(/RETURNING job_id, job, lease_epoch, current_attempt_id/);
    // …then the ledger work, on the transaction's own twin.
    expect(statements[4]?.sql).toMatch(/UPDATE everdict_execution_attempts/);
    expect(statements[4]?.params.slice(0, 2)).toEqual(["evd-run-1#g1", "superseded"]); // the PREDECESSOR ends
    expect(statements[5]?.sql).toMatch(/INSERT INTO everdict_execution_attempts/);
    expect(statements[6]?.params.slice(0, 2)).toEqual(["evd-run-1#g2", "executing"]);
    expect(statements[6]?.params[3]).toBe(2); // …stamped with the lease epoch that authorized it
    // …and the row restamp closes it: the job the runner will actually run, and the attempt the NEXT claim
    // will supersede.
    const restamp = statements[7];
    expect(restamp?.sql).toMatch(/SET job = COALESCE\(\$4::jsonb, job\), current_attempt_id = COALESCE\(\$5/);
    expect(restamp?.params[4]).toBe("evd-run-1#g2");
    for (const predicate of FENCE) expect(restamp?.sql ?? "").toMatch(predicate);
    expect(lease?.job.recordingGeneration).toBe(2); // the lease hands out the attempt it just minted
  });

  it("rolls the whole claim back when the mint throws — no COMMIT, so the job was never leased", async () => {
    const { client, statements } = transactional(reLeaseRows);
    await expect(
      new PgRunnerJobStore(client).claimAttempt(
        { owner: "u1", runnerId: "runner-1", leaseTtlMs: 1_000, now: 1_000 },
        () => Promise.reject(new Error("attempt ledger unreachable")),
      ),
    ).rejects.toThrow("attempt ledger unreachable");
    const sql = statements.map((s) => s.sql);
    expect(sql.at(-1)).toBe("ROLLBACK");
    expect(sql).not.toContain("COMMIT"); // "this runner holds a lease" and "the ledger has no row" never coexist
  });

  it("writes nothing but the claim when the mint yields no attempt — a first lease owes the row no restamp", async () => {
    const { client, statements } = transactional(reLeaseRows);
    await new PgRunnerJobStore(client).claimAttempt(
      { owner: "u1", runnerId: "runner-1", leaseTtlMs: 1_000, now: 1_000 },
      async () => ({}),
    );
    // BEGIN + the three claim statements + COMMIT: the row's job is already the one to hand out, and rewriting
    // it with itself on every first lease is a write bought for nothing.
    expect(statements.map((s) => s.sql)).toHaveLength(5);
    expect(statements.at(-1)?.sql).toBe("COMMIT");
  });

  it("leaves the fenced claim() path outside any transaction — an unpromoted deployment is unchanged", async () => {
    const { client, statements } = transactional(() => []);
    await new PgRunnerJobStore(client).claim({ owner: "u1", runnerId: "runner-1", leaseTtlMs: 1_000, now: 1_000 });
    expect(statements.map((s) => s.sql)).not.toContain("BEGIN");
    expect(statements).toHaveLength(3);
  });
});
