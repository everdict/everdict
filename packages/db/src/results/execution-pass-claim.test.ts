import type { ExecutionPass, ScorecardRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgScorecardStore } from "./pg-scorecard-store.js";
import { InMemoryScorecardStore } from "./scorecard-store.js";

// ── THE RETRY PASS IS CLAIMED, NOT ANNOUNCED (docs/architecture/in-place-case-retry-spec.md) ─────────
//
// An in-place retry mutates a settled plane, so exactly one pass may own it at a time. Read-check-write is
// not a lock — arch-review 8 paid for that on the scoring axis, where two replicas both read an absent
// marker and the second write silently replaced the first. The execution axis gets the same compare-and-swap
// rather than a second, cleverer spelling of it.
//
// Both stores are driven here on purpose. A twin that answers a guard more permissively than the adapter is
// the divergence rule `testing` exists for: every pass test would then be proving the branch production
// never takes.

const record = (over: Partial<ScorecardRecord> = {}): ScorecardRecord =>
  ({
    id: "sc-1",
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1.0.0" },
    status: "succeeded",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...over,
  }) as ScorecardRecord;

const pass = (over: Partial<ExecutionPass> = {}): ExecutionPass => ({
  passId: "p-1",
  epoch: 1,
  targetRevision: 1,
  baseRevision: 0,
  cases: [{ caseId: "c1" }],
  startedAt: "2026-09-04T00:00:00.000Z",
  status: "running",
  ...over,
});

describe("InMemoryScorecardStore — the claim refuses a rival, not just a duplicate", () => {
  it("a fresh claim wins when there is no marker", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record());
    const claimed = await store.update("sc-1", { executionPass: pass() }, undefined, {
      expectExecutionPassId: null,
    });
    expect(claimed?.executionPass?.passId).toBe("p-1");
  });

  it("REFUSES a second fresh claim — two retries must not both own one plane", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record({ executionPass: pass() }));
    // The rival read an absent marker a moment ago and is now writing. Without the CAS this write lands and
    // two passes retry the same cases, each under its own idea of the base revision.
    const rival = await store.update("sc-1", { executionPass: pass({ passId: "p-2", epoch: 2 }) }, undefined, {
      expectExecutionPassId: null,
    });
    expect(rival).toBeUndefined();
  });

  it("lets the OWNER write while its pass is running", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record({ executionPass: pass() }));
    const written = await store.update("sc-1", { steps: [] }, undefined, { expectExecutionPassId: "p-1" });
    expect(written).toBeDefined();
  });

  it("refuses a writer whose pass has FAILED — identity is not authority", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record({ executionPass: pass({ status: "failed" }) }));
    const late = await store.update("sc-1", { steps: [] }, undefined, { expectExecutionPassId: "p-1" });
    expect(late).toBeUndefined();
  });

  it("lets a takeover claim a marker whose lease has expired, and refuses one that is still live", async () => {
    const store = new InMemoryScorecardStore();
    const expired = new Date(Date.now() - 60_000).toISOString();
    await store.create(record({ executionPass: pass({ leaseUntil: expired }) }));
    expect(
      await store.update("sc-1", { executionPass: pass({ passId: "p-2", epoch: 2 }) }, undefined, {
        expectExecutionPassId: "p-1",
        expectExecutionPassReclaimable: true,
      }),
    ).toBeDefined();

    const live = new InMemoryScorecardStore();
    await live.create(
      record({ id: "sc-2", executionPass: pass({ leaseUntil: new Date(Date.now() + 60_000).toISOString() }) }),
    );
    // Staleness is a LEASE question, not an age question — a long retry behind a slow runtime legitimately
    // outlives any fixed window, and shooting it puts two writers on one plane.
    expect(
      await live.update("sc-2", { executionPass: pass({ passId: "p-2" }) }, undefined, {
        expectExecutionPassId: "p-1",
        expectExecutionPassReclaimable: true,
      }),
    ).toBeUndefined();
  });

  it("STAMPS the lease itself — the clock that judges an interval is the one that set it", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record());
    const claimed = await store.update("sc-1", { executionPass: pass() }, undefined, {
      expectExecutionPassId: null,
      stampExecutionLeaseSeconds: 120,
    });
    // The caller sent no lease at all. A store that let the caller author it would stop being a faithful
    // stand-in for the Pg one, which mints it in SQL.
    expect(claimed?.executionPass?.leaseUntil).toBeDefined();
    expect(Date.parse(claimed?.executionPass?.leaseUntil ?? "")).toBeGreaterThan(Date.now());
  });
});

describe("PgScorecardStore — the same decisions, written into the statement", () => {
  const capture = (): { client: SqlClient; sql: string[] } => {
    const sql: string[] = [];
    return {
      sql,
      client: {
        async query<T>(text: string) {
          sql.push(text);
          return { rows: [] as T[], rowCount: 0 };
        },
      } as unknown as SqlClient,
    };
  };

  it("puts the pass-identity CAS in the WHERE, not in a prior read", async () => {
    const { client, sql } = capture();
    await new PgScorecardStore(client).update("sc-1", { steps: [] }, undefined, { expectExecutionPassId: "p-1" });
    const text = sql.join("\n");
    expect(text).toContain("execution_pass->>'passId' = $");
    // …and the terminal-has-no-authority arm rides with it.
    expect(text).toContain("execution_pass->>'status' = 'running'");
  });

  it("expresses a fresh claim as 'there must be no marker'", async () => {
    const { client, sql } = capture();
    await new PgScorecardStore(client).update("sc-1", { executionPass: pass() }, undefined, {
      expectExecutionPassId: null,
    });
    expect(sql.join("\n")).toContain("execution_pass IS NULL OR execution_pass->>'passId' IS NULL");
  });

  it("asks the DATABASE whether a marker is reclaimable, against the database's own clock", async () => {
    const { client, sql } = capture();
    await new PgScorecardStore(client).update("sc-1", { executionPass: pass() }, undefined, {
      expectExecutionPassId: "p-1",
      expectExecutionPassReclaimable: true,
    });
    const text = sql.join("\n");
    // A replica running fast would otherwise declare a healthy pass dead against ITS clock and start a
    // second retry over the same plane.
    expect(text).toContain("(execution_pass->>'leaseUntil')::timestamptz <= now()");
    // …and naming an exact pass while taking over must NOT also demand it be running.
    expect(text).not.toContain("execution_pass->>'status' = 'running'");
  });

  it("mints the lease in SQL, in UTC", async () => {
    const { client, sql } = capture();
    await new PgScorecardStore(client).update("sc-1", { executionPass: pass() }, undefined, {
      expectExecutionPassId: null,
      stampExecutionLeaseSeconds: 90,
    });
    const text = sql.join("\n");
    expect(text).toContain("execution_pass = jsonb_set(");
    // `now()` renders in the SESSION's zone; stamping a literal Z onto a local rendering would write an
    // instant hours away from the one meant, and the reclaimability guard parses this back as timestamptz.
    expect(text).toContain("AT TIME ZONE 'UTC'");
  });

  it("writes every field of the execution axis — a settle that drops one moved a plane with no ledger", async () => {
    const { client, sql } = capture();
    await new PgScorecardStore(client).update(
      "sc-1",
      {
        executions: [{ revision: 1, kind: "retry", cases: [], createdAt: "t" }],
        caseAttempts: [],
        retrySummary: { cases: 1, attempts: 1 },
        executionPass: null,
      },
      undefined,
      undefined,
    );
    const text = sql.join("\n");
    for (const column of ["executions = $", "case_attempts = $", "retry_summary = $", "execution_pass = $"])
      expect(text, `missing ${column}`).toContain(column);
  });
});
