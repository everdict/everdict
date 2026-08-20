import type { Dispatcher } from "@everdict/backends";
import type { CaseJob, CaseResult, RuntimeWorkRef, TrackEntry } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { RuntimeSamplingDispatcher } from "./runtime-sampling-dispatcher.js";

// The replay runtime plane's producer loop: samples stream onto the recording WHILE the dispatch is in flight,
// and the sampler dies with the dispatch — never outliving it, never failing it.

const RESULT: CaseResult = {
  caseId: "c1",
  harness: "h@1",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
};

const jobFor = (target?: string, runId?: string): CaseJob => ({
  evalCase: {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
    ...(target ? { placement: { target } } : {}),
  },
  harness: { id: "h", version: "1" },
  tenant: "acme",
  ...(runId ? { runId } : {}),
});

// A managed dispatch RESERVES before it creates anything (Wave A), and the sampler now keys on that handle
// rather than on the case id — a sample resolved by case id could report another run's cpu and memory into
// this recording's runtime lane (arch-review 53, legacy removal). An inner that never reserves is a lane with
// no addressable work, and the loop correctly stays silent for it.
// The reservation a wired control plane makes: the store's proof, built from the handle the backend reports.
const reservation = async (work: RuntimeWorkRef) => ({
  attemptId: work.attemptId ?? `${work.runId}#g1`,
  work,
  persistedAt: "2026-08-18T00:00:00.000Z",
});

const slowInner = (ms: number): Dispatcher => ({
  dispatch: async (job, opts) => {
    await opts?.authority?.reserve({
      tenant: job.tenant ?? "default",
      runId: job.runId ?? "",
      externalJobId: `everdict-${job.evalCase.id}-aaaa`,
    });
    return new Promise((resolve) => setTimeout(() => resolve(RESULT), ms));
  },
});

describe("RuntimeSamplingDispatcher (replay runtime plane producer)", () => {
  it("streams orchestrator samples onto the recording's runtime lane while the dispatch runs, then stops", async () => {
    const recorded: Array<{ runId: string; item: TrackEntry }> = [];
    const dispatcher = new RuntimeSamplingDispatcher(slowInner(80), {
      sample: async () => ({ cpuPct: 12.5, memBytes: 1024 }),
      record: (runId, item) => recorded.push({ runId, item }),
      intervalMs: 20,
      now: () => 5000,
    });

    // A tracked run always arrives with a reservation hook — the composition wires it, and a managed
    // backend refuses to place work without one (arch-review 54, Phase 1). The sampler observes that hook
    // rather than owning it, so the fixture must carry it or it is testing a lane production never has.
    // ONE capability now: a fixture that could hand over half the protocol would be modelling a contract
    // production no longer has (arch-review 58 W2).
    const result = await dispatcher.dispatch(jobFor("rt-1", "evd-run-r1"), {
      authority: { reserve: reservation, activate: async () => ({ kind: "activate" }) },
    });
    expect(result).toEqual(RESULT);
    expect(recorded.length).toBeGreaterThanOrEqual(2);
    expect(recorded[0]?.runId).toBe("evd-run-r1");
    expect(recorded[0]?.item).toEqual({ track: "runtime", entry: { t: 5000, cpuPct: 12.5, memBytes: 1024 } });

    // The interval died with the dispatch — nothing new arrives after settle.
    const settledCount = recorded.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(recorded.length).toBe(settledCount);
  });

  it("does not sample a self-hosted target, a job with no runId, or an empty sample — and never fails the run", async () => {
    const sampled: string[] = [];
    const recorded: TrackEntry[] = [];
    const make = (inner: Dispatcher) =>
      new RuntimeSamplingDispatcher(inner, {
        sample: async (_t, target) => {
          sampled.push(target);
          return {};
        },
        record: (_runId, item) => recorded.push(item),
        intervalMs: 5,
      });

    // self-hosted lane: the control plane cannot reach the runner's container — no sampling attempted.
    await make(slowInner(25)).dispatch(jobFor("self:runner-1", "evd-run-r2"));
    // no CP-minted runId: nothing to key the recording on.
    await make(slowInner(25)).dispatch(jobFor("rt-1"));
    expect(sampled).toHaveLength(0);

    // an empty sample (backend answered but knew nothing) records no entry.
    const empty = new RuntimeSamplingDispatcher(slowInner(25), {
      sample: async () => ({}),
      record: (_runId, item) => recorded.push(item),
      intervalMs: 5,
    });
    await empty.dispatch(jobFor("rt-1", "evd-run-r3"));
    expect(recorded).toHaveLength(0);

    // a throwing sampler is swallowed — the dispatch result is untouched.
    const throwing = new RuntimeSamplingDispatcher(slowInner(25), {
      sample: async () => {
        throw new Error("stats down");
      },
      record: (_runId, item) => recorded.push(item),
      intervalMs: 5,
    });
    expect(await throwing.dispatch(jobFor("rt-1", "evd-run-r4"))).toEqual(RESULT);
  });
});
