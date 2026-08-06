import type { Dispatcher } from "@everdict/backends";
import type { CaseJob, CaseResult, TrackEntry } from "@everdict/contracts";
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

const slowInner = (ms: number): Dispatcher => ({
  dispatch: () => new Promise((resolve) => setTimeout(() => resolve(RESULT), ms)),
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

    const result = await dispatcher.dispatch(jobFor("rt-1", "evd-run-r1"));
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
