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
    for (const predicate of FENCE) expect(sql).toMatch(predicate);
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

describe("PgRunnerJobStore — a cancelled job is revoked in the statement, not merely flagged", () => {
  it("claim() neither requeues nor takes a cancelled job (both statements)", async () => {
    const { client, statements } = capture();
    await new PgRunnerJobStore(client).claim({ owner: "u1", runnerId: "runner-1", leaseTtlMs: 1_000, now: 1_000 });
    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql ?? "").toMatch(REVOKED); // the expired-lease requeue
    expect(statements[1]?.sql ?? "").toMatch(REVOKED); // the candidate SELECT
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
    expect(statements).toHaveLength(4);
    for (const s of statements) expect(s.sql).toMatch(REVOKED);
  });

  it("touch() is the deliberate exception — it reports the cancel but freezes the activity clock", async () => {
    const { client, statements } = capture();
    await new PgRunnerJobStore(client).touch("j1", "runner-1", 3, 1_000);
    const sql = statements[0]?.sql ?? "";
    // Not gated: the reply is how the runner is TOLD to abort, so it has to reach a cancelled holder…
    expect(sql).not.toMatch(REVOKED);
    expect(sql).toMatch(/RETURNING cancel_requested/);
    // …but the renewal stops, so a runner that ignores the signal is reclaimed by the idle-timeout path.
    expect(sql).toMatch(/CASE WHEN cancel_requested THEN activity_at ELSE to_timestamp/);
  });
});
