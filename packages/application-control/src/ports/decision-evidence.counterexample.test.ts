import { describe, expect, it } from "vitest";
import { trajectoryForAttempt, trajectoryForDecision } from "./trajectory-store.js";

// ── A DISPLAY READ AND A DECISION READ ARE NOT ONE READ (arch-review 53, Wave B) ─────────────────────
//
// Wave 7's exact-identity read ranks the asked-for attempt above the clock and refuses a plane that declares
// a DIFFERENT attempt. It also keeps a plane that declares NONE — deliberately, and the reasoning is sound
// for a viewer: evidence sealed before attempts had names (and every plane whose producer does not declare
// one — a judge's, a service's) is still this run's evidence, and dropping it would decay the record.
//
// It is not sound for a DECISION. A caller holding a receipt-selected `attemptId` is asking "give me the
// bytes that attempt produced", and an unattributed plane is not an answer to that question — it is an
// answer to a different one ("give me what we have for this run") returned under the same type, with no
// field distinguishing the two. So a gate, a judge input, or a receipt verification consumes attribution it
// never checked, and nothing in the result says so.
//
// The invariant these pin: the exact read has two callers with two contracts — `forDisplay` may return
// unattributed evidence and must say that it did; `forDecision` returns an exact match or answers absent/
// unknown, and never substitutes.

const plane = (emitter: string, attemptId?: string) => ({
  emitter,
  source: "run",
  eventCount: 1,
  sealedAt: "2026-08-17T00:00:00.000Z",
  format: "everdict",
  ...(attemptId !== undefined ? { attemptId } : {}),
  events: [{ t: 0, kind: "message", role: "assistant", text: emitter }],
});

const sealed = (segments: ReturnType<typeof plane>[]) =>
  ({
    meta: {
      runId: "child-1",
      tenant: "acme",
      source: "run",
      eventCount: segments.length,
      sealedAt: "2026-08-17T00:00:00.000Z",
    },
    events: segments[0]?.events ?? [],
    executionEmitter: segments[0]?.emitter ?? "run",
    segments,
  }) as never;

// RED as of 186f9fd9: the unattributed plane rides back with the exact one under the same type, so a
// decision-grade caller cannot tell which half it is holding.
describe("[R53 WAVE-B COUNTEREXAMPLE #28 — CLOSED] a decision read returns only what the identity vouches for", () => {
  it("does not serve an unattributed plane as the asked-for attempt's evidence", () => {
    const both = sealed([plane("run", "evd-run-1#g2"), plane("judge:a")]);

    const decided = trajectoryForDecision(both, "evd-run-1#g2");

    // Exactly the plane the identity vouches for — the unattributed one is not this attempt's evidence.
    expect(decided?.segments).toHaveLength(1);
    expect(decided?.segments[0]?.attemptId).toBe("evd-run-1#g2");
  });

  it("the display read states that it included evidence nothing attributed", () => {
    const both = sealed([plane("run", "evd-run-1#g2"), plane("judge:a")]);
    const kept = trajectoryForAttempt(both, "evd-run-1#g2") as
      | { segments?: unknown[]; unattributedSegments?: number }
      | undefined;

    expect(kept?.segments?.length).toBe(2);
    // A viewer may be shown the pair; it must be TOLD that one half is unattributed rather than left to
    // infer attribution the record does not carry.
    expect(kept?.unattributedSegments, "unattributed evidence is returned with nothing marking it as such").toBe(1);
  });
});
