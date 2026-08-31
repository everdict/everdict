import { ClickHouseTrajectoryStore } from "@everdict/db";
import { beforeAll, describe, expect, it } from "vitest";
import { TRUST_CH_ENABLED, trustClickHouseCommand, trustClickHouseUrl, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-192.
//
// THE RECEIPT'S ATTEMPT AND THE BYTES IT IS SERVED ARE ONE JOIN, EXECUTED BY THE ENGINE.
//
// Several physical attempts seal under one run id. `planeRows` ranks them `exact attempt (0) · unattributed
// (1) · another attempt (2)` and takes the best; the split EVENT read resolved by `argMin(body, sealed_at)` —
// clock alone, on a table with no attempt column — so a receipt naming attempt B was answered with B's header
// over whichever attempt sealed FIRST. Both halves internally consistent, and the join between them wrong.
//
// This scenario is the certification the unit counterexample cannot be. That one asserts the SQL TEXT carries
// `argMin(field, (attempt_rank, sealed_at))`; whether a tuple actually orders that way in ClickHouse, whether
// `attempt_rank < 2` drops the foreign rows before the aggregate, and whether the DEFAULT fills `''` for rows
// written before the column — those are the engine's answers, and a fake that echoes the query proves none of
// them.
//
// The setup writes rows DIRECTLY. `seal` reads the planes first and refuses a second seal of the same
// emitter, so it cannot produce the state under test — which is exactly the race the resolution exists for:
// two attempts that both passed that pre-read and both wrote.
describe.skipIf(!TRUST_CH_ENABLED)("TRUST-192 — a split plane serves the asked-for attempt's bytes", () => {
  const store = (): ClickHouseTrajectoryStore =>
    new ClickHouseTrajectoryStore({ url: TRUST_CH_ENABLED ? trustClickHouseUrl() : "http://unused" });

  beforeAll(async () => {
    await store().ensureSchema();
  });

  // Two attempts, same run and emitter, DIFFERENT bytes — and A seals first, so a clock-only resolution
  // answers A whatever the caller asked for.
  async function raceSealed(runId: string, tenant: string): Promise<void> {
    const plane = (attempt: string, sealedAt: string) =>
      JSON.stringify({
        run_id: runId,
        tenant,
        source: "run",
        emitter: "run",
        event_count: 1,
        body: "[]",
        body_format: "events",
        sealed_at: sealedAt,
        attempt_id: attempt,
        body_split: 1,
      });
    const event = (attempt: string, sealedAt: string, text: string) =>
      JSON.stringify({
        run_id: runId,
        emitter: "run",
        seq: 1,
        body: JSON.stringify({ t: 0, kind: "message", role: "assistant", text }),
        bytes: 64,
        sealed_at: sealedAt,
        attempt_id: attempt,
      });
    await trustClickHouseCommand(
      "INSERT INTO default.everdict_trajectories FORMAT JSONEachRow",
      `${plane("attempt-a", "2026-08-30T00:00:00.000Z")}\n${plane("attempt-b", "2026-08-30T00:00:05.000Z")}`,
    );
    await trustClickHouseCommand(
      "INSERT INTO default.everdict_trajectory_events FORMAT JSONEachRow",
      `${event("attempt-a", "2026-08-30T00:00:00.000Z", "FROM ATTEMPT A")}\n${event("attempt-b", "2026-08-30T00:00:05.000Z", "FROM ATTEMPT B")}`,
    );
  }

  const textOf = (page: Awaited<ReturnType<ClickHouseTrajectoryStore["events"]>>): string => {
    if (page.kind !== "page") throw new Error(`expected a page, got ${page.kind}`);
    const first = page.page.events?.[0];
    return typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
  };

  it("serves the LATER attempt's bytes when the receipt names it — not the first sealer's", async () => {
    const runId = trustId("ch-race");
    const tenant = trustId("acme");
    await raceSealed(runId, tenant);

    // The defect, exactly: attempt B sealed second, so a clock-first read answers A's bytes under B's header.
    const b = await store().events(tenant, runId, { emitter: "run", limit: 10, attemptId: "attempt-b" });
    expect(textOf(b)).toBe("FROM ATTEMPT B");
  });

  it("serves the EARLIER attempt's bytes when the receipt names that one", async () => {
    const runId = trustId("ch-race-a");
    const tenant = trustId("acme");
    await raceSealed(runId, tenant);
    const a = await store().events(tenant, runId, { emitter: "run", limit: 10, attemptId: "attempt-a" });
    expect(textOf(a)).toBe("FROM ATTEMPT A");
  });

  // An attempt that sealed nothing must not be answered with somebody else's bytes. `attempt_rank < 2` drops
  // the foreign rows, so the page is empty rather than a substitution.
  it("answers nothing for an attempt that sealed no rows, rather than another attempt's", async () => {
    const runId = trustId("ch-race-c");
    const tenant = trustId("acme");
    await raceSealed(runId, tenant);
    const c = await store().events(tenant, runId, { emitter: "run", limit: 10, attemptId: "attempt-c" });
    // `planeRows` refuses the plane outright (HAVING min(attempt_rank) < 2), which is the same answer one
    // level up: nothing this attempt produced is here.
    expect(c.kind).toBe("absent");
  });

  // A plane sealed with NO attempt is the ordinary case and still reads by clock across all rows.
  it("still serves an unattributed plane to a caller that names no attempt", async () => {
    const runId = trustId("ch-plain");
    const tenant = trustId("acme");
    await store().seal({
      runId,
      tenant,
      source: "run",
      events: [{ t: 0, kind: "message", role: "assistant", text: "PLAIN" }],
    });
    const page = await store().events(tenant, runId, { emitter: "run", limit: 10 });
    expect(textOf(page)).toBe("PLAIN");
  });

  // The seal writes the identity it was given, so a later exact read has something to match on.
  it("writes the attempt onto the event rows it seals", async () => {
    const runId = trustId("ch-attributed");
    const tenant = trustId("acme");
    await store().seal({
      runId,
      tenant,
      source: "run",
      attemptId: "attempt-z",
      events: [{ t: 0, kind: "message", role: "assistant", text: "ATTRIBUTED" }],
    });
    const stored = await trustClickHouseCommand(
      `SELECT attempt_id FROM default.everdict_trajectory_events WHERE run_id = '${runId}' FORMAT TabSeparated`,
    );
    expect(stored.trim()).toBe("attempt-z");
    const page = await store().events(tenant, runId, { emitter: "run", limit: 10, attemptId: "attempt-z" });
    expect(textOf(page)).toBe("ATTRIBUTED");
  });
});
