import { describe, expect, it } from "vitest";
import { ClickHouseTrajectoryStore } from "./clickhouse-trajectory-store.js";

// ── THE EXACT PLANE WAS SELECTED IS NOT THE EXACT BYTES WERE SELECTED ────────────────────────────────
//
// Several physical attempts can seal under one run id, and a receipt names WHICH one produced the evidence.
// `planeRows` honours that: it ranks rows `exact attempt (0) · unattributed (1) · another attempt (2)` and
// takes the best. The LEGACY body read learned the same ranking in arch-review 122, under a comment that
// says why — "asking by attempt and then reading the body by clock is how the header came to name one
// execution over another's bytes".
//
// The SPLIT event read, which serves every modern plane, did not:
//
//     SELECT seq, argMin(body, sealed_at) … WHERE run_id = … AND emitter = … GROUP BY seq
//
// `sealed_at` alone is first-write-WINS BY CLOCK, on a table that had no attempt column at all. So a receipt
// selecting attempt B is answered with B's header over whichever attempt sealed first — and the comment above
// it claimed the parity that was missing ("the same first-write-wins resolution the plane rows use"; the
// plane rows rank by attempt FIRST and break ties by clock).
//
// Both halves are internally consistent, which is what makes it evidence substitution rather than a crash:
// every digest downstream agrees with its own input, and the join between the receipt's identity and the
// bytes is the thing that is wrong.
//
// These tests read the SQL this store sends. That is a text assertion and it is deliberately the weaker half
// — TRUST-192 executes the same resolution against a real ClickHouse, because a `argMin(x, tuple)` either
// orders the way this claims or it does not, and no string can tell you which.

// One SPLIT plane, so the read reaches the event table instead of short-circuiting on an absent trajectory.
const PLANE_ROW = {
  run_id: "run-1",
  emitter: "run",
  tenant_first: "acme",
  source_first: "run",
  event_count_first: 2,
  kind_first: "",
  label_first: "",
  preview_first: "",
  t0_first: "",
  usage_first: "",
  body_split_first: 1,
  batch_first: "",
  body_format_first: "",
  attempt_id_first: "attempt-b",
  sealed_at_first: "2026-08-30T00:00:00.000Z",
};

function recording(): { store: ClickHouseTrajectoryStore; sent: () => string[] } {
  const sent: string[] = [];
  const fetchImpl = (async (url: URL | string) => {
    const query = decodeURIComponent(new URL(String(url)).searchParams.get("query") ?? "");
    sent.push(query);
    // The plane read answers with one split plane; everything else answers empty, which is enough to reach
    // the event queries and record them.
    const body = /GROUP BY run_id, emitter/.test(query) ? `${JSON.stringify(PLANE_ROW)}\n` : "";
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { sent: () => sent, store: new ClickHouseTrajectoryStore({ url: "http://ch:8123" }, fetchImpl) };
}

const eventReads = (sent: string[]): string[] =>
  sent.filter((q) => /FROM\s+\S*everdict_trajectory_events/.test(q) && /^\s*SELECT/.test(q));

describe("a split plane's bytes are resolved by the attempt that was asked for", () => {
  it("ranks event rows by attempt, not by clock alone, when a window names one", async () => {
    const { store, sent } = recording();
    await store.events("acme", "run-1", { emitter: "run", limit: 50, attemptId: "attempt-b" }).catch(() => undefined);

    const reads = eventReads(sent());
    expect(reads.length, "no event read was issued — this would prove nothing").toBeGreaterThan(0);
    for (const query of reads) {
      // The rank participates in the resolution, and the clock is only the tie-break inside it.
      expect(query).toMatch(/attempt_rank/);
      expect(query).toMatch(/argMin\([a-z_]+, \(attempt_rank, sealed_at\)\)/);
      // …and a row belonging to ANOTHER attempt is excluded outright rather than ranked last and still
      // reachable when the wanted attempt sealed nothing for that seq.
      expect(query).toMatch(/attempt_rank\s*<\s*2/);
    }
  });

  it("uses the same resolution for the SIZES read as for the bodies", async () => {
    const { store, sent } = recording();
    await store.events("acme", "run-1", { emitter: "run", limit: 50, attemptId: "attempt-b" }).catch(() => undefined);

    // Sizes decide which seqs make the page and bodies fill it. Resolving them differently would page one
    // attempt's byte counts and serve another's text.
    const byField = eventReads(sent()).map((q) => (/argMin\(bytes,/.test(q) ? "bytes" : "body"));
    expect(byField).toContain("bytes");
    for (const query of eventReads(sent())) expect(query).toMatch(/\(attempt_rank, sealed_at\)/);
  });

  // A read that names NO attempt must still see every plane — ranking against an empty attempt id would give
  // rank 2 to every attributed row and answer nothing at all.
  it("leaves an attempt-free read resolving by clock across all rows", async () => {
    const { store, sent } = recording();
    await store.events("acme", "run-1", { emitter: "run", limit: 50 }).catch(() => undefined);
    for (const query of eventReads(sent())) {
      expect(query).not.toMatch(/attempt_rank/);
      expect(query).toMatch(/argMin\([a-z_]+, sealed_at\)/);
    }
  });

  it("writes the attempt onto every event row, so there is something to rank", async () => {
    const { store, sent } = recording();
    await store.ensureSchema().catch(() => undefined);
    await store
      .seal({
        runId: "run-1",
        tenant: "acme",
        source: "run",
        attemptId: "attempt-b",
        events: [
          { t: 0, kind: "message", role: "assistant", text: "one" },
          { t: 1, kind: "message", role: "assistant", text: "two" },
        ],
      })
      .catch(() => undefined);
    // The rows travel as the POST body, not the query, so the assertion is on what the INSERT declares it is
    // writing — the column has to be in the schema for the rank to have anything to read.
    const ddl = sent().filter((q) => /everdict_trajectory_events/.test(q) && /CREATE TABLE|ALTER TABLE/.test(q));
    expect(ddl.join("\n")).toMatch(/attempt_id/);
  });
});
