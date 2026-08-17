import { InMemoryCaseReceiptStore, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { CaseJob, EvalCase, RunRecord } from "@everdict/contracts";
import { InMemoryRunStore } from "@everdict/db";
import { Run } from "@everdict/domain";
import { describe, expect, it, vi } from "vitest";

// ── A READ THAT FAILED IS NOT AN EMPTY SET (arch-review 53, Wave A.5) ────────────────────────────────
//
// The type layer got `KillOutcome.unknown` in Wave 3 and an exact-attempt trajectory read in Wave 7, and both
// are then thrown away one layer up, by the same idiom in three places:
//
//     attempts.list(executionId).catch(() => [])          → no handles → broad case-id kill
//     caseReceipts.list(scorecardId).catch(() => [])       → no canonical attempt → clock-resolved evidence
//     runtimeRegistry.get(tenant, target).catch(() => undefined) → no backend called → worstKillOutcome([]) = absent
//
// Each converts "I could not find out" into "there is nothing", and each then takes the action reserved for
// genuine absence: widen the blast radius, serve whichever evidence sealed first, certify a cancellation that
// asked no cluster anything. The port comments say so out loud — "an unreadable ledger is the same situation
// as an empty one" — which is what makes this a protocol decision to reverse rather than a slip to patch.
//
// The invariant these pin: an authority read answers `read | absent | unknown`, and `unknown` never widens
// scope, never re-dispatches, and never completes a teardown.

const CASE: EvalCase = {
  id: "c1",
  env: { kind: "repo", source: { files: {} } },
  task: "t",
  graders: [],
  timeoutSec: 60,
  tags: [],
};

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("no dispatch in these tests");
  },
};

const now = "2026-08-17T00:00:00.000Z";

const runningRun = (over: Partial<RunRecord> = {}): RunRecord => ({
  ...Run.newQueued({
    id: "r1",
    tenant: "acme",
    harness: { id: "scripted", version: "0" },
    evalCase: CASE,
    runtime: "nomad-1",
    submittedBy: "alice",
    now,
  }),
  status: "running",
  ...over,
});

// RED as of 186f9fd9: `expected "spy" to not be called` — workHandles() swallows the ledger error, returns [],
// and the `works.length > 0` branch falls through to the case-id kill.
describe.skip("[R53 WAVE-A.5 COUNTEREXAMPLE #9] an unreadable attempt ledger does not widen the blast radius", () => {
  it("refuses to fall back to the case-id kill when the handle ledger could not be read", async () => {
    const store = new InMemoryRunStore();
    await store.create(runningRun());
    const killCase = vi.fn(async () => ({ status: "stopped" as const }));
    const killWork = vi.fn(async () => ({ status: "stopped" as const }));
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store,
      killCase,
      killWork,
      // The ledger is down — not empty. Whether this run placed managed work is UNKNOWN.
      attempts: {
        async list() {
          throw new Error("attempt ledger unavailable");
        },
      },
      cancelQueued: () => 0,
      cancelLeased: async () => 0,
      now: () => now,
    } as never);

    // The teardown must not converge on a guess. Either it refuses (leaving the operation owed) or it reports
    // an unconverged outcome — what it must NEVER do is stop every job that shares this case id.
    await service.cancel({ tenant: "acme", id: "r1" }).catch(() => undefined);

    expect(killCase, "cancel widened to the case id on an unreadable ledger").not.toHaveBeenCalled();
  });
});

// RED as of 186f9fd9: the exact read is skipped and the clock-resolved read is served instead.
describe.skip("[R53 WAVE-A.5 COUNTEREXAMPLE #10] an unreadable receipt ledger does not downgrade the evidence read", () => {
  it("refuses the clock-resolved trajectory when the canonical attempt could not be determined", async () => {
    const store = new InMemoryRunStore();
    await store.create(runningRun({ id: "child-1", status: "succeeded", parentScorecardId: "sc-1" }));
    const asked: Array<string | undefined> = [];
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store,
      trajectories: {
        async get(_tenant: string, runId: string, opts?: { attemptId: string }) {
          asked.push(opts?.attemptId);
          const events = [{ t: 0, kind: "message", role: "assistant", text: "done" }];
          return {
            meta: { runId, tenant: "acme", source: "run", eventCount: 1, sealedAt: now },
            events,
            executionEmitter: "run",
            segments: [{ emitter: "run", source: "run", eventCount: 1, sealedAt: now, format: "everdict", events }],
          };
        },
      },
      // The receipt ledger is down. WHICH attempt this child's verdict rests on is unknown.
      caseReceipts: {
        async list() {
          throw new Error("receipt ledger unavailable");
        },
        async commit() {},
      },
      now: () => now,
    } as never);

    const trajectory = await service.trajectory("acme", "child-1", "alice").catch(() => undefined);

    // A decision-grade read must not silently become the best-effort one. Serving the clock's answer here is
    // exactly the substitution Wave 7's exact read exists to refuse.
    expect(
      trajectory === undefined || asked.every((a) => a !== undefined),
      "an unreadable receipt ledger fell back to the clock-resolved plane",
    ).toBe(true);
  });
});

// RED as of 186f9fd9: `InMemoryCaseReceiptStore` has no three-valued read; the port answers with a bare array.
describe.skip("[R53 WAVE-A.5 COUNTEREXAMPLE #11] the authority ports answer in three values", () => {
  it("a receipt ledger read reports read | absent | unknown rather than an array that means both", async () => {
    const store = new InMemoryCaseReceiptStore();
    const read = (store as unknown as Record<string, unknown>).read;
    expect(typeof read, "CaseReceiptStore has no three-valued read").toBe("function");
  });
});

// The self-hosted lane's stop arms take a predicate over CaseJob — kept here so the counterexample above
// cannot be satisfied by removing them.
export const _predicateShape = (job: CaseJob): boolean => job.runId === "r1";
