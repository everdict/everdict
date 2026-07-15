import { describe, expect, it } from "vitest";
import type { RunnerLoopDeps, RunnerLoopOpts } from "./runner-loop.js";
import { superviseLease } from "./runner-supervisor.js";

const deps: RunnerLoopDeps = {
  callJson: async () => ({}),
  runJob: async () => ({
    caseId: "c",
    harness: "h@0",
    trace: [],
    snapshot: { kind: "prompt", output: "" },
    scores: [],
  }),
};
const opts = (shouldStop: () => boolean): RunnerLoopOpts => ({
  maxConcurrent: 1,
  waitMs: 0,
  heartbeatMs: 1_000,
  pollMs: 0,
  capabilities: [],
  shouldStop,
});

describe("superviseLease — runner self-heal watchdog", () => {
  it("restarts the pool when it crashes (unforeseen throw) instead of dying, until shouldStop", async () => {
    let stop = false;
    let runs = 0;
    const restarts: number[] = [];
    const runPool = async (): Promise<void> => {
      runs++;
      if (runs <= 2) throw new Error(`crash ${runs}`); // first two generations crash unexpectedly
      stop = true; // third generation "runs" then a stop is requested — the supervisor should exit after it
    };
    await superviseLease(
      deps,
      opts(() => stop),
      {
        runPool,
        restartMs: 0,
        sleep: async () => {},
        onRestart: (n) => restarts.push(n),
      },
    );
    expect(runs).toBe(3); // crashed twice, restarted twice, ran a third time
    expect(restarts).toEqual([1, 2]); // two restarts logged
  });

  it("does NOT restart on a clean stop — the pool returns and shouldStop is already true", async () => {
    let runs = 0;
    const runPool = async (): Promise<void> => {
      runs++; // returns normally (workers drained on shouldStop)
    };
    // shouldStop flips true right after the first pool run returns (as a real stop() would).
    let firstDone = false;
    await superviseLease(
      deps,
      opts(() => firstDone),
      {
        runPool: async () => {
          await runPool();
          firstDone = true;
        },
        restartMs: 0,
        sleep: async () => {},
      },
    );
    expect(runs).toBe(1); // ran once, then stop → no restart
  });

  it("never starts the pool if already stopped", async () => {
    let runs = 0;
    await superviseLease(
      deps,
      opts(() => true),
      { runPool: async () => void runs++, sleep: async () => {} },
    );
    expect(runs).toBe(0);
  });
});
