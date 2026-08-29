import type { TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type TrajectoryEventsResult, type TrajectoryWindow, collectTrajectoryEvents } from "./trajectory-store.js";

// ── [R121 COUNTEREXAMPLE] A COLLECTED TRACE IS BOUNDED, OR IT IS REFUSED ────────────────────────────
//
// Every other ceiling on this path is now real: one event is bounded, a stored page is bounded, and a
// RESOLVED page is bounded in bytes. The collector that scoring actually calls was bounded by nothing — it
// pages politely and pushes every event into one array, so peak heap is the size of the whole trace:
//
//     for await (const event of streamTrajectoryEvents(...)) events.push(event);
//
// The pages were a bound on the DATABASE response, never on the process. A long-horizon run scored in the
// shared control plane takes the whole control plane with it, which is every tenant's outage caused by one
// case's trace.
//
//     the read is paged   ≠   the caller holds one page at a time
//
// Refusing is the honest close. A judge cannot score a trace that does not fit in memory, and the two
// answers available are "say so" and "die": one is attributable to a case and diagnosable, the other is a
// process nobody can blame. `streamTrajectoryEvents` is still there for a consumer that folds incrementally
// — the bound belongs on the convenience that materializes, not on the stream.
//
// Seen RED before the fix: "an unbounded trace was collected into one array: promise resolved instead of
// rejecting".
function storeOf(pages: TraceEvent[][]): Pick<TrajectoryStore, "events"> {
  return {
    async events(_tenant: string, _runId: string, window: TrajectoryWindow): Promise<TrajectoryEventsResult> {
      const index = window.after ?? 0;
      const events = pages[index] ?? [];
      return {
        kind: "page",
        page: {
          emitter: "run",
          format: "events",
          events,
          eventCount: pages.flat().length,
          ...(index + 1 < pages.length ? { nextAfter: index + 1 } : {}),
        },
      };
    },
  };
}

// The ceiling is INJECTED so `limit + 1` is a few kilobytes rather than a quarter of a gigabyte. A test that
// must allocate the real ceiling to prove the ceiling exists does not prove it by assertion — it proves it by
// dying, which is exactly the outcome this bound replaces.
const TEST_LIMIT = 4_096;
const page = (marker: number): TraceEvent[] => [
  { t: marker, kind: "tool_result", id: `c${marker}`, ok: true, output: "z".repeat(2_048) },
];

type TrajectoryStore = import("./trajectory-store.js").TrajectoryStore;

describe("[R121 COUNTEREXAMPLE] the collector refuses a trace it cannot hold", () => {
  it("REFUSES past the declared maximum instead of growing the array", async () => {
    // Enough pages to exceed the ceiling with room to spare.
    const pages = Array.from({ length: 8 }, (_, i) => page(i));
    await expect(
      collectTrajectoryEvents(storeOf(pages), "acme", "r1", {}, TEST_LIMIT),
      "an unbounded trace was collected into one array",
    ).rejects.toThrow(/too large to score|exceeds/i);
  });

  it("collects an ordinary trace untouched — the bound is a ceiling, not a page size", async () => {
    const pages = [
      [{ t: 0, kind: "message", role: "user", text: "hi" } as TraceEvent],
      [{ t: 1, kind: "tool_result", id: "c1", ok: true, output: "small" } as TraceEvent],
    ];
    const events = await collectTrajectoryEvents(storeOf(pages), "acme", "r1", {}, TEST_LIMIT);
    expect(events, "an ordinary trace was cut by the ceiling").toHaveLength(2);
  });
});
