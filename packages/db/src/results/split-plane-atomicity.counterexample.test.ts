import type { TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgTrajectoryStore } from "./trajectory-store.js";

// ── A PLANE THAT CLAIMS N EVENTS IS NOT N EVENT ROWS ─────────────────────────────────────────────────
//
// A split plane is a header (`body_split = true`, `event_count = N`, `body = []`) plus N rows in
// `everdict_trajectory_events`. Those were two statements, so they were two COMMITS:
//
//     INSERT INTO everdict_trajectories (… event_count = N …) ON CONFLICT DO NOTHING RETURNING
//     if (inserted) await writeEvents(…)          ← a second commit
//
// and the segment path was three, counting the `segment_event_count` bump. A failure between them leaves a
// header claiming N events over ZERO rows, and the retry meets `ON CONFLICT DO NOTHING` → `created: false`,
// which reports success and repairs nothing.
//
// This is not hypothetical: `writeEvents`' statement carried an ambiguous `value` column and was refused by
// the planner on EVERY call until a real-Postgres scenario found it, which is exactly the window in which
// header-only planes were produced. And the standalone run seals fire-and-forget AFTER the outcome is
// already committed, so the run is terminal while its evidence is not.
//
// The two halves, and why each needs its own test:
//
//   WRITE — one statement, so there is no window. A data-modifying CTE is this repository's default way to
//           make two writes atomic (see `SqlClient.transaction`'s own comment) and needs no transaction, so
//           it works on every client rather than refusing on the ones that cannot transact.
//   READ  — a header-only plane ALREADY EXISTS in deployments that ran the broken statement. Serving it as
//           an empty page makes "evidence missing" indistinguishable from "evidence empty", and every
//           downstream consumer accepts the second as an answer. It has to refuse.

const EVENTS: TraceEvent[] = [
  { t: 0, kind: "message", role: "assistant", text: "one" },
  { t: 1, kind: "message", role: "assistant", text: "two" },
  { t: 2, kind: "message", role: "assistant", text: "three" },
];

const isWrite = (text: string): boolean => /\b(INSERT|UPDATE)\b/i.test(text);
const touches = (text: string, table: string): boolean => new RegExp(`\\b${table}\\b`).test(text);
// An event write standing alone IS the second commit — it must always ride with the plane row it belongs to,
// whichever of the two plane tables that is.
const orphanEventWrites = (writes: string[]): string[] =>
  writes.filter(
    (t) =>
      touches(t, "everdict_trajectory_events") &&
      !touches(t, "everdict_trajectories") &&
      !touches(t, "everdict_trajectory_segments"),
  );

// Records every statement so the test can count COMMITS rather than trust a comment.
function recordingClient(rows: (text: string) => Record<string, unknown>[]): {
  client: SqlClient;
  writes: () => string[];
} {
  const texts: string[] = [];
  return {
    writes: () => texts.filter(isWrite),
    client: {
      async query(text: string) {
        texts.push(text);
        return { rows: rows(text) as never[] };
      },
    },
  };
}

describe("sealing a split plane is one commit", () => {
  it("writes the header and its event rows in a single statement", async () => {
    // No primary row yet, and the header INSERT reports that it won.
    const { client, writes } = recordingClient((text) =>
      touches(text, "everdict_trajectories") && isWrite(text) ? [{ run_id: "run-1" }] : [],
    );
    await new PgTrajectoryStore(client).seal({
      runId: "run-1",
      tenant: "acme",
      source: "run",
      events: EVENTS,
    });

    // The property, stated as a count: every statement that writes event rows also writes the plane row it
    // belongs to. A lone `INSERT INTO everdict_trajectory_events` IS the second commit.
    expect(orphanEventWrites(writes())).toEqual([]);
    // …and the plane is written exactly once, so this cannot pass by writing nothing.
    expect(writes().filter((t) => touches(t, "everdict_trajectory_events"))).toHaveLength(1);
  });

  it("writes a SEGMENT, its event rows and the aggregate bump in a single statement", async () => {
    const primary = {
      run_id: "run-1",
      tenant: "acme",
      source: "run",
      emitter: "run",
      event_count: 3,
      segment_event_count: 0,
      t0: null,
      sealed_at: "2026-08-30T00:00:00.000Z",
      owner: null,
      kind: null,
      label: null,
      preview: null,
    };
    // The header INSERT loses its ON CONFLICT (the primary plane is already sealed), which is what sends the
    // seal down the segment path; the segment INSERT wins.
    const { client, writes } = recordingClient((text) => {
      if (!isWrite(text)) return [primary as Record<string, unknown>];
      return touches(text, "everdict_trajectory_segments") ? [{ run_id: "run-1" }] : [];
    });
    await new PgTrajectoryStore(client).seal({
      runId: "run-1",
      tenant: "acme",
      source: "run",
      emitter: "judge:quality",
      events: EVENTS,
    });

    const segmentWrites = writes().filter((t) => touches(t, "everdict_trajectory_segments"));
    expect(segmentWrites).toHaveLength(1);
    const [statement] = segmentWrites;
    // All three effects, one statement: the segment row, its events, and the counter that must not drift
    // from them.
    expect(touches(statement ?? "", "everdict_trajectory_events")).toBe(true);
    expect(/UPDATE\s+everdict_trajectories/i.test(statement ?? "")).toBe(true);
    // The other write is the header INSERT that LOST its ON CONFLICT — that is what sends the seal down this
    // path, and it writes nothing. What must not exist is an event write standing on its own.
    expect(orphanEventWrites(writes())).toEqual([]);
  });
});

describe("a header claiming events it does not have is refused, not served empty", () => {
  // The plane row says three events and the event table has none — a seal that lost its second commit, or a
  // deployment that ran the statement the planner refused.
  function corrupted(): SqlClient {
    return {
      async query(text: string) {
        if (text.includes("UNION ALL"))
          return {
            rows: [
              {
                emitter: "run",
                source: "run",
                event_count: 3,
                t0: null,
                sealed_at: "2026-08-30T00:00:00.000Z",
                body_format: null,
                attempt_id: null,
                body_split: true,
                batch: null,
                usage: null,
                tenant: "acme",
                header: true,
              },
            ] as never[],
          };
        return { rows: [] as never[] }; // …and no event rows at any seq
      },
    };
  }

  it("refuses the page rather than reporting the trajectory as empty", async () => {
    const store = new PgTrajectoryStore(corrupted());
    await expect(store.events("acme", "run-1", { emitter: "run", limit: 50 })).rejects.toThrow(
      /claims 3 event\(s\).*no rows|incomplete/i,
    );
  });

  // A plane that legitimately sealed ZERO events is not corrupt — it is a plane with nothing in it, and the
  // refusal must not swallow that case.
  it("still serves a plane that sealed no events at all", async () => {
    const empty: SqlClient = {
      async query(text: string) {
        if (text.includes("UNION ALL"))
          return {
            rows: [
              {
                emitter: "run",
                source: "run",
                event_count: 0,
                t0: null,
                sealed_at: "2026-08-30T00:00:00.000Z",
                body_format: null,
                attempt_id: null,
                body_split: true,
                batch: null,
                usage: null,
                tenant: "acme",
                header: true,
              },
            ] as never[],
          };
        return { rows: [] as never[] };
      },
    };
    const page = await new PgTrajectoryStore(empty).events("acme", "run-1", { emitter: "run", limit: 50 });
    expect(page.kind).toBe("page");
  });
});
