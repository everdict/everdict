import type { ExecutionAttemptRecord, ExecutionId, RunRecord } from "@everdict/contracts";
import { storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { retainedDispositionOf } from "./retained-disposition.js";

// ── A PHYSICAL ATTEMPT'S END IS NOT THE CASE'S END (arch-review 76 P1) ──────────────────────────────
//
// The legacy-retained sweeper decides whether intermediates may be collected, and it has been wrong twice.
// First it answered `unknown` for every batch coordinate, so the lane holding most of the leak was never
// migrated at all. Then it read the attempt ledger and folded it with
//
//     attempts.every(isTerminalAttemptState)   →   terminal
//
// which is a different sentence from the one the certificate needs. `failed` means THIS physical attempt
// ended badly; `superseded` means another attempt owns the case, or this one was abandoned. Both are
// terminal for the row and say nothing about the case — and the ledger exists precisely to hold several
// attempts per case, so there is always a window where every attempt recorded so far is terminal and the
// replacement has not opened yet.
//
// Seen RED before the child join, observed:
//   attempt failed, child still running → terminal (the retry's artifacts became collectable)
//
// The coordinate for the logical half was already on the row: `childRunId`. No parsing of a rendered
// execution id — which L3 forbids and which a scorecard id full of its own dashes makes impossible anyway.

const BATCH = storedExecutionId("evd-2f1c-9b7a-case-1");
const STANDALONE = storedExecutionId("evd-run-r1");

const attempt = (over: Partial<ExecutionAttemptRecord>): ExecutionAttemptRecord =>
  ({ attemptId: "a1", executionId: BATCH, state: "failed", childRunId: "child-1", ...over }) as ExecutionAttemptRecord;

const run = (status: string): RunRecord => ({ id: "child-1", status }) as unknown as RunRecord;

function deps(over: {
  attempts?: ExecutionAttemptRecord[] | "throws";
  runs?: Record<string, RunRecord> | "throws";
}) {
  // Captured before the closures: narrowing does not survive a closure boundary, and an `attempts.list` that
  // can answer `undefined` is a double more permissive than the port (rule `testing`).
  const rows = over.attempts;
  return {
    runs: {
      async get(id: string) {
        if (over.runs === "throws") throw new Error("the run ledger did not answer");
        return over.runs?.[id];
      },
    },
    ...(rows !== undefined
      ? {
          attempts: {
            async list(_e: ExecutionId): Promise<ExecutionAttemptRecord[]> {
              if (rows === "throws") throw new Error("the attempt ledger did not answer");
              return rows;
            },
          },
        }
      : {}),
  };
}

describe("[R76 COUNTEREXAMPLE] a retained debt is released only when the CASE is over", () => {
  it("refuses to collect while the child is still running, though every attempt is terminal", async () => {
    // The retry gap, exactly: attempt #1 failed, attempt #2 has not opened, the child is still going.
    const disposition = retainedDispositionOf(
      deps({ attempts: [attempt({ state: "failed" })], runs: { "child-1": run("running") } }),
    );

    const answer = await disposition("acme", BATCH);

    expect(answer.kind, "a terminal attempt over a running child released the retry's artifacts").toBe("live");
  });

  it("refuses when every attempt was SUPERSEDED and the replacement has not landed", async () => {
    // The other spelling of the same window. `superseded` means somebody else owns the case — which is not
    // a statement that the case finished.
    const disposition = retainedDispositionOf(
      deps({ attempts: [attempt({ state: "superseded" })], runs: { "child-1": run("queued") } }),
    );

    expect((await disposition("acme", BATCH)).kind).toBe("live");
  });

  it("COLLECTS when the attempts are terminal AND the child is", async () => {
    // The control. A resolver that refused everything would be a migration that never migrates — which is
    // the state this sweeper was in before it could address batch coordinates at all.
    const disposition = retainedDispositionOf(
      deps({ attempts: [attempt({ state: "committed" })], runs: { "child-1": run("succeeded") } }),
    );

    expect((await disposition("acme", BATCH)).kind).toBe("terminal");
  });

  it("stays LIVE while any attempt is still open, without reading a child at all", async () => {
    const disposition = retainedDispositionOf(deps({ attempts: [attempt({ state: "active" })], runs: {} }));

    expect((await disposition("acme", BATCH)).kind).toBe("live");
  });

  it("answers UNKNOWN for every ledger that will not say — never terminal", async () => {
    // L2, three ways. "We could not find out" is not a licence to collect, and each of these used to be, or
    // would be, a quiet `terminal` under a fold that only counted attempt states.
    const unreadableAttempts = retainedDispositionOf(deps({ attempts: "throws" }));
    expect((await unreadableAttempts("acme", BATCH)).kind).toBe("unknown");

    const noRows = retainedDispositionOf(deps({ attempts: [], runs: {} }));
    expect((await noRows("acme", BATCH)).kind, "an execution the ledger never recorded was collected").toBe("unknown");

    const noLedger = retainedDispositionOf(deps({ runs: {} }));
    expect((await noLedger("acme", BATCH)).kind).toBe("unknown");

    const unreadableChild = retainedDispositionOf(deps({ attempts: [attempt({ state: "failed" })], runs: "throws" }));
    expect((await unreadableChild("acme", BATCH)).kind).toBe("unknown");

    // …and an attempt row that names no child cannot answer the logical question either.
    const noCoordinate = retainedDispositionOf(
      deps({ attempts: [attempt({ state: "failed", childRunId: undefined })], runs: {} }),
    );
    expect((await noCoordinate("acme", BATCH)).kind).toBe("unknown");
  });

  it("reads a STANDALONE execution straight from its run row", async () => {
    // The lane that always worked, kept working — and kept fail-closed: a run the ledger cannot produce is
    // unknown, not gone.
    const done = retainedDispositionOf(deps({ runs: { r1: { id: "r1", status: "succeeded" } as RunRecord } }));
    expect((await done("acme", STANDALONE)).kind).toBe("terminal");

    const running = retainedDispositionOf(deps({ runs: { r1: { id: "r1", status: "running" } as RunRecord } }));
    expect((await running("acme", STANDALONE)).kind).toBe("live");

    const absent = retainedDispositionOf(deps({ runs: {} }));
    expect((await absent("acme", STANDALONE)).kind).toBe("unknown");
  });
});
