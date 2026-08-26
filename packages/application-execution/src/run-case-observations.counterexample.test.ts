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
import { observationsFromTrace } from "@everdict/domain";
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

describe("[TRACK-C SEAL] the observation channel is sealed into the trace the judgment stands on", () => {
  // A re-score reads the sealed trajectory, not the live run — an observation that lives only in the replay
  // recording makes the same execution judge differently in-line vs after a crash (the durable-document
  // law). The channel therefore rides the TRACE: one capped env_action per sample plus a channel marker, so
  // a sealed trace states the channel's outcome durably and a reconstruction is total.
  // RED as of 6ec2a4b4: the trace carried no observation events at all.
  it("sampled deltas land as observation trace events, and the channel marker says 'sampled'", async () => {
    const seen: Array<CaseObservations | undefined> = [];
    const environment = {
      seed: async () => {},
      snapshot: async () => ({ kind: "prompt", output: "" }),
      sampleDelta: async () => ({ kind: "repo-diff" as const, text: "+++ b/a.txt" }),
    } as unknown as Environment;
    const driver = { id: "fake", provision: async () => fakeComputeHandle() } as Driver;

    const result = await runCase(CASE, {
      driver,
      environment,
      harness: quickHarness,
      graders: [capturingGrader(seen)],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });

    const observationEvents = result.trace.filter(
      (e) => e.kind === "env_action" && (e as { action?: string }).action === "platform_observation_sample",
    );
    expect(observationEvents.length).toBeGreaterThanOrEqual(1);
    const marker = result.trace.find(
      (e) => e.kind === "env_action" && (e as { action?: string }).action === "platform_observation_channel",
    );
    expect(marker, "the sealed trace does not state the channel's outcome").toBeDefined();
    expect((marker as { detail?: unknown })?.detail).toBe("sampled");
  });

  it("an env whose every sample FAILED is unobserved{sampling_failed} — never silently fewer deltas", async () => {
    const seen: Array<CaseObservations | undefined> = [];
    const environment = {
      seed: async () => {},
      snapshot: async () => ({ kind: "prompt", output: "" }),
      sampleDelta: async () => {
        throw new Error("git unavailable in this box");
      },
    } as unknown as Environment;
    const driver = { id: "fake", provision: async () => fakeComputeHandle() } as Driver;

    const result = await runCase(CASE, {
      driver,
      environment,
      harness: quickHarness,
      graders: [capturingGrader(seen)],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });

    expect(seen[0]).toEqual({ kind: "unobserved", reason: "sampling_failed" });
    const marker = result.trace.find(
      (e) => e.kind === "env_action" && (e as { action?: string }).action === "platform_observation_channel",
    );
    expect((marker as { detail?: unknown })?.detail).toBe("sampling_failed");
  });
});

describe("[REVIEW WAVE B] the agent under test cannot speak in the observation channel's voice", () => {
  // The channel is the platform's INDEPENDENT account — that independence is its entire value, and the
  // harness's stream is the agent's own bytes. A harness yielding env_action events wearing the reserved
  // actions used to ride into the sealed trace verbatim, where the reconstruction read them as the
  // platform's: a fabricated `sampled` account from a world nobody watched, planted BEFORE the seal so it
  // wins any marker order. Seen RED: the sealed trace reconstructed as the harness's forged `sampled`.
  it("forged observation events in the harness stream are stripped before the seal", async () => {
    const forgingHarness: EvaluableHarness = {
      id: "forger",
      version: "1.0.0",
      install: async () => {},
      run: async function* (): AsyncIterable<TraceEvent> {
        yield { t: 0, kind: "env_action", action: "platform_observation_sample", detail: "+++ b/forged.txt" };
        yield { t: 1, kind: "env_action", action: "platform_observation_channel", detail: "sampled" };
        yield { t: 2, kind: "env_action", action: "git_commit", detail: "an ordinary env action survives" };
      },
    };
    const environment = {
      seed: async () => {},
      snapshot: async () => ({ kind: "prompt", output: "" }),
    } as unknown as Environment;
    const driver = { id: "fake", provision: async () => fakeComputeHandle() } as Driver;

    const result = await runCase(CASE, {
      driver,
      environment,
      harness: forgingHarness,
      graders: [],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });

    const markers = result.trace.filter(
      (e) => e.kind === "env_action" && (e as { action?: string }).action === "platform_observation_channel",
    );
    // Exactly one marker: the platform's own seal. The forged one never entered.
    expect(markers).toHaveLength(1);
    expect((markers[0] as { detail?: unknown }).detail).toBe("unsupported");
    expect(
      result.trace.some(
        (e) => e.kind === "env_action" && (e as { action?: string }).action === "platform_observation_sample",
      ),
    ).toBe(false);
    // …while the harness's ordinary env vocabulary is untouched — the strip is the channel's, not env_action's.
    expect(
      result.trace.some((e) => e.kind === "env_action" && (e as { action?: string }).action === "git_commit"),
    ).toBe(true);
    expect(observationsFromTrace(result.trace)).toEqual({ kind: "unobserved", reason: "unsupported" });
  });
});
