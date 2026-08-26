import type {
  CaseObservations,
  ComputeHandle,
  Driver,
  Environment,
  EvalCase,
  EvaluableHarness,
  Grader,
  TraceEvent,
} from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { runCase } from "./run-case.js";

// ── THE OBSERVATION IS DELIVERED TO THE JUDGMENT (docs/architecture/evolution-lineage.md, Track C) ───
//
// `EnvDelta[]` is an INDEPENDENT observation of the world — sampled by the environment, never reported by
// the agent — and its only terminal consumer was the replay recording. No grader or judge could read it, so
// claim-vs-observation divergence ("the trace says tests were fixed; the diff shows the test file was
// deleted") was computable from data we already collect and computed nowhere. These drive the PRODUCTION
// runCase and assert the value reaches the grader's context — three-valued, because "no observation
// channel" must never read as "observed: nothing changed" (L2).
//
// RED as of 7b271636: `expected undefined to matchObject { kind: 'sampled', … }` — GradeContext carried no
// observation channel at all.

const CASE = { id: "c1", env: { kind: "prompt" }, task: "do it", graders: [], timeoutSec: 60, tags: [] } as EvalCase;

const quickHarness: EvaluableHarness = {
  id: "quick",
  version: "1.0.0",
  install: async () => {},
  run: async function* (): AsyncIterable<TraceEvent> {
    yield { t: 0, kind: "log", text: "done", stream: "stdout" } as TraceEvent;
  },
};

function fakeComputeHandle(): ComputeHandle {
  return {
    image: { kind: "none" },
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    writeFile: async () => {},
    readFile: async () => "",
    dispose: async () => {},
  } as unknown as ComputeHandle;
}

function capturingGrader(seen: Array<CaseObservations | undefined>): Grader {
  return {
    id: "observing",
    grade: async (ctx) => {
      seen.push((ctx as { observations?: CaseObservations }).observations);
      return { metric: "observing", status: "measured", value: 1 };
    },
  } as Grader;
}

describe("[TRACK-C COUNTEREXAMPLE] the world's own account reaches the grader", () => {
  it("an environment that samples deltas hands the grader `sampled` with the collected series", async () => {
    const seen: Array<CaseObservations | undefined> = [];
    const environment = {
      seed: async () => {},
      snapshot: async () => ({ kind: "prompt", output: "" }),
      sampleDelta: async () => ({ kind: "repo-diff" as const, text: "+++ b/a.txt" }),
    } as unknown as Environment;
    const driver = { id: "fake", provision: async () => fakeComputeHandle() } as Driver;

    await runCase(CASE, {
      driver,
      environment,
      harness: quickHarness,
      graders: [capturingGrader(seen)],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "sampled" });
    if (seen[0]?.kind !== "sampled") throw new Error("unreachable");
    // The recorder samples on its own cadence plus the final pre-teardown sample — at least one delta landed,
    // and it is the environment's account, not the agent's.
    expect(seen[0].deltas.length).toBeGreaterThanOrEqual(1);
    expect(seen[0].deltas[0]).toMatchObject({ kind: "repo-diff", text: "+++ b/a.txt" });
  });

  it("an environment with no sampling answers `unobserved{unsupported}` — never an empty series", async () => {
    const seen: Array<CaseObservations | undefined> = [];
    const environment = {
      seed: async () => {},
      snapshot: async () => ({ kind: "prompt", output: "" }),
    } as unknown as Environment;
    const driver = { id: "fake", provision: async () => fakeComputeHandle() } as Driver;

    await runCase(CASE, {
      driver,
      environment,
      harness: quickHarness,
      graders: [capturingGrader(seen)],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });

    expect(seen[0]).toEqual({ kind: "unobserved", reason: "unsupported" });
  });
});
