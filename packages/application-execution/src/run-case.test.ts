import type {
  ComputeHandle,
  ComputeSpec,
  Driver,
  Environment,
  EvalCase,
  EvaluableHarness,
  TraceEvent,
} from "@everdict/contracts";
import { AppError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { runCase } from "./run-case.js";

// A compute handle that records whether it was disposed — disposal is how runCase frees the runtime, so a
// cancelled run must reach it (docker rm -f / process kill happens inside a real driver's dispose()).
function fakeComputeHandle(): ComputeHandle & { disposed: boolean } {
  const handle = {
    disposed: false,
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    writeFile: async () => {},
    readFile: async () => "",
    dispose: async () => {
      handle.disposed = true;
    },
  };
  return handle;
}

const CASE = { id: "c1", env: { kind: "prompt" }, task: "do it", graders: [], timeoutSec: 60, tags: [] } as EvalCase;

const ENVIRONMENT = {
  seed: async () => {},
  snapshot: async () => ({ kind: "prompt", output: "" }),
} as unknown as Environment;

// A harness whose run yields one event then hangs forever (a long-running agent) — so only cancellation (or a
// backend kill) can end it. `started` resolves once run() has begun, so the test can abort mid-run deterministically.
function hangingHarness(started: () => void): EvaluableHarness {
  return {
    id: "hang",
    version: "1.0.0",
    install: async () => {},
    run: async function* (): AsyncIterable<TraceEvent> {
      yield { t: 0, kind: "log", text: "begin", stream: "stdout" } as TraceEvent;
      started();
      await new Promise<void>(() => {}); // hang — never yields again
    },
  };
}

describe("runCase — cooperative cancellation via runCtx.signal", () => {
  it("throws CANCELLED and disposes the compute when the signal is already aborted", async () => {
    const compute = fakeComputeHandle();
    const driver = { id: "fake", provision: async () => compute } as Driver;
    const controller = new AbortController();
    controller.abort();

    await expect(
      runCase(CASE, {
        driver,
        environment: ENVIRONMENT,
        harness: hangingHarness(() => {}),
        graders: [],
        runCtx: { apiKeyEnv: {}, timeoutSec: 60, signal: controller.signal },
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(compute.disposed).toBe(true); // the runtime is freed even though the harness never finished
  });

  it("aborts a hanging run mid-flight — throws CANCELLED and disposes the compute (frees the runtime)", async () => {
    const compute = fakeComputeHandle();
    const driver = { id: "fake", provision: async () => compute } as Driver;
    const controller = new AbortController();
    // Abort as soon as the harness has started running (mid-case) — this is the heartbeat-cancel moment.
    const harness = hangingHarness(() => controller.abort());

    const err = await runCase(CASE, {
      driver,
      environment: ENVIRONMENT,
      harness,
      graders: [],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60, signal: controller.signal },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("CANCELLED");
    expect(compute.disposed).toBe(true);
  });

  it("without a signal, a normally-completing run is unaffected (byte-identical path)", async () => {
    const compute = fakeComputeHandle();
    const driver = { id: "fake", provision: async () => compute } as Driver;
    const harness: EvaluableHarness = {
      id: "quick",
      version: "1.0.0",
      install: async () => {},
      run: async function* (): AsyncIterable<TraceEvent> {
        yield { t: 0, kind: "log", text: "done", stream: "stdout" } as TraceEvent;
      },
    };

    const result = await runCase(CASE, {
      driver,
      environment: ENVIRONMENT,
      harness,
      graders: [],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });
    expect(result.caseId).toBe("c1");
    expect(compute.disposed).toBe(true);
  });

  it("records the sandbox teardown as a stamped placement fact — the lifecycle phase no plane accounted for", async () => {
    const compute = fakeComputeHandle();
    const driver = { id: "fake", provision: async () => compute } as Driver;
    const harness: EvaluableHarness = {
      id: "quick",
      version: "1.0.0",
      install: async () => {},
      run: async function* (): AsyncIterable<TraceEvent> {
        yield { t: 0, kind: "log", text: "done", stream: "stdout" } as TraceEvent;
      },
    };
    const result = await runCase(CASE, {
      driver,
      environment: ENVIRONMENT,
      harness,
      graders: [],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });
    const released = result.trace.find((e) => e.kind === "infra" && e.event === "compute_released");
    if (released?.kind !== "infra") throw new Error("expected the teardown to be recorded");
    expect(released.scope).toBe("placement");
    expect(Number.isFinite(Date.parse(released.at ?? ""))).toBe(true); // on the wall clock, like every mark
    expect(released.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// A harness that yields one event and completes (a normal short run) — so runCase reaches snapshot → env-delta final
// sample → release → return.
function completingHarness(): EvaluableHarness {
  return {
    id: "scripted",
    version: "1.0.0",
    install: async () => {},
    run: async function* (): AsyncIterable<TraceEvent> {
      yield { t: 0, kind: "log", text: "hello", stream: "stdout" } as TraceEvent;
    },
  };
}

describe("runCase — in-run environment deltas (the recorder plane)", () => {
  it("captures the environment's sampleDelta onto CaseResult.envDeltas", async () => {
    const compute = fakeComputeHandle();
    const driver = { id: "fake", provision: async () => compute } as Driver;
    // A repo-like environment that exposes a non-intrusive delta (git-diff). runCase takes a final sample before
    // release, so even this sub-cadence run records the end state.
    const repoEnv = {
      kind: "repo",
      seed: async () => {},
      snapshot: async () => ({ kind: "repo", diff: "", changedFiles: [], headSha: "abc" }),
      sampleDelta: async () => ({ kind: "repo-diff", text: "diff --git a/f b/f\n+added" }),
    } as unknown as Environment;

    const result = await runCase(CASE, {
      driver,
      environment: repoEnv,
      harness: completingHarness(),
      graders: [],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });

    expect(result.envDeltas).toHaveLength(1);
    expect(result.envDeltas?.[0]).toMatchObject({ kind: "repo-diff", text: "diff --git a/f b/f\n+added" });
  });

  it("omits envDeltas when the environment exposes no sampleDelta (e.g. prompt/browser)", async () => {
    const compute = fakeComputeHandle();
    const driver = { id: "fake", provision: async () => compute } as Driver;

    const result = await runCase(CASE, {
      driver,
      environment: ENVIRONMENT, // prompt env — no sampleDelta
      harness: completingHarness(),
      graders: [],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });

    expect(result.envDeltas).toBeUndefined();
  });
});

describe("runCase — teardown failure never destroys the produced result", () => {
  it("returns the finished result (scores, snapshot, trace) even when compute.dispose() throws", async () => {
    // Given a compute whose teardown dies (a docker rm -f timeout is the realistic trigger)
    const compute = fakeComputeHandle();
    compute.dispose = async () => {
      compute.disposed = true;
      throw new Error("docker rm -f timed out");
    };
    const driver = { id: "fake", provision: async () => compute } as Driver;

    // When the case runs to completion
    const result = await runCase(CASE, {
      driver,
      environment: ENVIRONMENT,
      harness: completingHarness(),
      graders: [],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });

    // Then the result survives — the janitor's failure is recorded as lifecycle evidence, not propagated
    // (pre-fix: release() threw, the finally re-entered a latched no-op, and the whole CaseResult was lost)
    expect(result.caseId).toBe("c1");
    const releaseMark = result.trace.find((e) => e.kind === "infra" && "event" in e && e.event === "compute_released");
    expect(releaseMark && "message" in releaseMark ? releaseMark.message : "").toContain("compute may be leaked");
  });
});

describe("runCase — an abort landing after the drain still cancels", () => {
  it("throws CANCELLED instead of producing a normal sealed result for a stopped case", async () => {
    const compute = fakeComputeHandle();
    const driver = { id: "fake", provision: async () => compute } as Driver;
    const controller = new AbortController();
    // The harness COMPLETES its drain, then the abort lands before snapshot/grading — the window the
    // drain-race alone could not observe.
    const harness: EvaluableHarness = {
      id: "finishes-then-stopped",
      version: "1.0.0",
      install: async () => {},
      run: async function* (): AsyncIterable<TraceEvent> {
        yield { t: 0, kind: "log", text: "done", stream: "stdout" } as TraceEvent;
        controller.abort(); // lands as the drain ends — post-race, pre-snapshot
      },
    };

    await expect(
      runCase(CASE, {
        driver,
        environment: ENVIRONMENT,
        harness,
        graders: [],
        runCtx: { apiKeyEnv: {}, timeoutSec: 60, signal: controller.signal },
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(compute.disposed).toBe(true);
  });
});

describe("runCase — the case's world rides the ComputeSpec", () => {
  it("derives needs from the env kind instead of hardcoding shell (browser env asks for a browser)", async () => {
    // Regression: needs was the literal ["shell"], so a browser/os-use case reached the driver with a
    // declaration that said nothing — the pre-flight gates had nothing to refuse or satisfy.
    const captured: Array<{ os: string; needs: string[] }> = [];
    const compute = fakeComputeHandle();
    const driver = {
      id: "fake",
      provision: async (spec: { os: string; needs?: string[] }) => {
        captured.push({ os: spec.os, needs: spec.needs ?? [] });
        return compute;
      },
    } as Driver;

    await runCase({ ...CASE, env: { kind: "browser" } } as EvalCase, {
      driver,
      environment: ENVIRONMENT,
      harness: completingHarness(),
      graders: [],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });
    expect(captured[0]).toEqual({ os: "linux", needs: ["shell", "browser"] });
  });
});

describe("runCase — the execution manifest records the world the case actually ran in", () => {
  it("records a defaulted linux AS defaulted when the case declared no os", async () => {
    // Given: a case with no placement at all — the `?? "linux"` decision used to be made here and dropped,
    // so afterwards nobody could tell this apart from a case that deliberately asked for linux.
    const result = await runCase(CASE, {
      driver: { id: "local", provision: async () => fakeComputeHandle() } as Driver,
      environment: ENVIRONMENT,
      harness: completingHarness(),
      graders: [],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });
    // Then: the world AND the fact that the default chose it are both on the result.
    expect(result.execution).toEqual({ os: "linux", osResolved: "defaulted", driver: "local" });
  });

  it("records an authored windows AS declared, and rides the driver that provisioned the compute", async () => {
    const result = await runCase({ ...CASE, placement: { os: "windows" } } as EvalCase, {
      driver: { id: "docker", provision: async () => fakeComputeHandle() } as Driver,
      environment: ENVIRONMENT,
      harness: completingHarness(),
      graders: [],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });
    expect(result.execution).toEqual({ os: "windows", osResolved: "declared", driver: "docker" });
  });

  it("records the image the compute was provisioned from when the case named one", async () => {
    const result = await runCase({ ...CASE, image: "ghcr.io/acme/swe:1" } as EvalCase, {
      driver: { id: "docker", provision: async () => fakeComputeHandle() } as Driver,
      environment: ENVIRONMENT,
      harness: completingHarness(),
      graders: [],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });
    expect(result.execution?.image).toBe("ghcr.io/acme/swe:1");
  });
});

// ── THE DECLARATION HAS TO REACH THE THING THAT ENFORCES IT ─────────────────────────────────────────
//
// `EvalCase.resources` / `EvalCase.network` are enforced (or refused) by the driver, which means the only
// thing standing between a declared world and a silently ignored one is this hop. A field that never
// arrives fails exactly like a field that was never declared, and the drivers' own tests cannot tell the
// difference — they build the ComputeSpec themselves. So the wiring is asserted here, at the seam.
describe("runCase — the world a case declares reaches the driver", () => {
  const worldCase = {
    ...CASE,
    resources: { cpu: 2000, memoryMb: 4096 },
    network: { mode: "none" as const, allowedHosts: [] },
  } as EvalCase;

  const quietHarness: EvaluableHarness = {
    id: "quiet",
    version: "1.0.0",
    install: async () => {},
    run: async function* (): AsyncIterable<TraceEvent> {},
  };

  it("forwards the case's resources and network policy verbatim into the ComputeSpec", async () => {
    const seen: ComputeSpec[] = [];
    const driver = {
      id: "fake",
      provision: async (spec: ComputeSpec) => {
        seen.push(spec);
        return fakeComputeHandle();
      },
    } as Driver;

    await runCase(worldCase, {
      driver,
      environment: ENVIRONMENT,
      harness: quietHarness,
      graders: [],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.resources).toEqual({ cpu: 2000, memoryMb: 4096 });
    expect(seen[0]?.network).toEqual({ mode: "none", allowedHosts: [] });
  });

  it("leaves both unset when the case declared neither — absence stays absence", async () => {
    const seen: ComputeSpec[] = [];
    const driver = {
      id: "fake",
      provision: async (spec: ComputeSpec) => {
        seen.push(spec);
        return fakeComputeHandle();
      },
    } as Driver;

    await runCase(CASE, {
      driver,
      environment: ENVIRONMENT,
      harness: quietHarness,
      graders: [],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });

    expect(seen[0]).not.toHaveProperty("resources");
    expect(seen[0]).not.toHaveProperty("network");
  });
});
