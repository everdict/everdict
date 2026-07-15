import type { ComputeHandle, Driver, Environment, EvalCase, EvaluableHarness, TraceEvent } from "@everdict/contracts";
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
});
