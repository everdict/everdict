import type { TraceEvent } from "@everdict/contracts";
import { PgTrajectoryStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-191.
//
// A SPLIT PLANE'S HEADER AND ITS EVENT ROWS ARE ONE COMMIT, AND ONLY AN ENGINE SAYS SO.
//
// The seal writes a plane row claiming `event_count = N` and N rows in `everdict_trajectory_events`. Those
// were two statements, so a failure between them left a header over zero rows — served by the reader as an
// EMPTY trajectory rather than a missing one, which every consumer above accepts as an answer. They are one
// data-modifying CTE now, and the segment path is three effects in one statement (segment row, its events,
// and the `segment_event_count` aggregate that must never drift from them).
//
// This scenario exists because that construction is not verifiable anywhere else. A CTE whose second arm
// draws FROM the first arm's RETURNING — which is what makes "only the winner writes events" a property of
// the statement instead of an `if` around a second one — is either something the planner accepts and orders
// correctly, or it is not, and no in-memory twin and no SQL-text assertion can tell you which. The unit
// counterexample (`split-plane-atomicity.counterexample.test.ts`) proves the STATEMENT COUNT; this proves the
// statement WORKS.
//
// ⚠️ The predecessor of this path shipped broken for exactly this reason: `writeEvents` carried an ambiguous
// `value` column and was refused by the planner on every call, while the fake SqlClient asserted on SQL text
// and the in-memory twin ran its own JavaScript. It was found by the first scenario to execute it.
describe.skipIf(!TRUST_PG_ENABLED)("TRUST-191 — a split plane seals atomically, against a real database", () => {
  let pg: TrustPg;
  beforeAll(async () => {
    pg = await openTrustPg();
  });
  afterAll(async () => pg?.close());

  const events = (n: number): TraceEvent[] =>
    Array.from({ length: n }, (_, i) => ({ t: i, kind: "message", role: "assistant", text: `event ${i}` }) as const);

  const countEvents = async (runId: string, emitter: string): Promise<number> => {
    const res = await pg.client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM everdict_trajectory_events WHERE run_id = $1 AND emitter = $2",
      [runId, emitter],
    );
    return Number(res.rows[0]?.n ?? "0");
  };

  it("writes the header and every event row it claims", async () => {
    const runId = trustId("run-seal");
    const tenant = trustId("acme");
    const store = new PgTrajectoryStore(pg.client);

    const meta = await store.seal({ runId, tenant, source: "run", events: events(5) });
    expect(meta.created).toBe(true);

    // The header's claim…
    const header = await pg.client.query<{ event_count: number; body_split: boolean }>(
      "SELECT event_count, body_split FROM everdict_trajectories WHERE run_id = $1",
      [runId],
    );
    expect(header.rows[0]).toMatchObject({ event_count: 5, body_split: true });
    // …and the rows that are that claim. Written by the same statement, so these cannot disagree.
    expect(await countEvents(runId, "run")).toBe(5);

    // And the read serves them — the half a row count alone does not prove.
    const page = await store.events(tenant, runId, { emitter: "run", limit: 50 });
    expect(page.kind).toBe("page");
    if (page.kind !== "page") throw new Error("unreachable");
    expect(page.page.eventCount).toBe(5);
  });

  it("writes a SEGMENT, its event rows and the aggregate bump together", async () => {
    const runId = trustId("run-segment");
    const tenant = trustId("acme");
    const store = new PgTrajectoryStore(pg.client);

    await store.seal({ runId, tenant, source: "run", events: events(3) });
    const appended = await store.seal({
      runId,
      tenant,
      source: "run",
      emitter: "judge:quality",
      events: events(4),
    });
    expect(appended.created).toBe(true);

    expect(await countEvents(runId, "judge:quality")).toBe(4);
    // The denormalized counter, bumped inside the segment's own statement.
    const agg = await pg.client.query<{ segment_event_count: number }>(
      "SELECT segment_event_count FROM everdict_trajectories WHERE run_id = $1",
      [runId],
    );
    expect(agg.rows[0]?.segment_event_count).toBe(4);
  });

  // The rule the CTE encodes: a plane that LOSES its `ON CONFLICT` writes no event rows, because the events
  // arm draws from the winner's RETURNING and a losing arm returns nothing. Previously this was an `if`
  // around a second statement; now it is the statement, and a planner that ordered the arms the other way
  // would show up here as duplicate or orphan rows.
  it("a losing seal of the same emitter writes no second set of event rows", async () => {
    const runId = trustId("run-race");
    const tenant = trustId("acme");
    const store = new PgTrajectoryStore(pg.client);

    await store.seal({ runId, tenant, source: "run", events: events(2) });
    const again = await store.seal({ runId, tenant, source: "run", events: events(9) });
    expect(again.created).toBe(false);

    // Still the winner's two — not eleven, and not nine.
    expect(await countEvents(runId, "run")).toBe(2);
    const header = await pg.client.query<{ event_count: number }>(
      "SELECT event_count FROM everdict_trajectories WHERE run_id = $1",
      [runId],
    );
    expect(header.rows[0]?.event_count).toBe(2);
  });

  it("a losing SEGMENT seal bumps the aggregate exactly once", async () => {
    const runId = trustId("run-segment-race");
    const tenant = trustId("acme");
    const store = new PgTrajectoryStore(pg.client);

    await store.seal({ runId, tenant, source: "run", events: events(1) });
    await store.seal({ runId, tenant, source: "run", emitter: "judge:a", events: events(6) });
    const loser = await store.seal({ runId, tenant, source: "run", emitter: "judge:a", events: events(6) });
    expect(loser.created).toBe(false);

    expect(await countEvents(runId, "judge:a")).toBe(6);
    const agg = await pg.client.query<{ segment_event_count: number }>(
      "SELECT segment_event_count FROM everdict_trajectories WHERE run_id = $1",
      [runId],
    );
    // Twelve would mean the bump ran for a segment row that was never inserted.
    expect(agg.rows[0]?.segment_event_count).toBe(6);
  });
});
