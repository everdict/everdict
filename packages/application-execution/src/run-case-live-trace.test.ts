import type { ComputeHandle, Driver, Environment, EvalCase, EvaluableHarness, TraceEvent } from "@everdict/contracts";
import { NO_IMAGE } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import { runCase } from "./run-case.js";

const CASE = { id: "c1", env: { kind: "prompt" }, task: "do it", graders: [], timeoutSec: 60, tags: [] } as EvalCase;

const ENVIRONMENT = {
  seed: async () => {},
  snapshot: async () => ({ kind: "prompt", output: "" }),
} as unknown as Environment;

function fakeCompute(): ComputeHandle & { disposed: boolean } {
  const handle = {
    disposed: false,
    image: NO_IMAGE,
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    writeFile: async () => {},
    readFile: async () => "",
    dispose: async () => {
      handle.disposed = true;
    },
  };
  return handle;
}

describe("runCase — live-trace tee (runCtx.liveTrace)", () => {
  it("reports drained TraceEvents to the live observer while the harness runs, in order", async () => {
    const driver = { id: "fake", provision: async () => fakeCompute() } as Driver;
    const reported: TraceEvent[] = [];
    let firstBatch = (): void => {};
    const gotBatch = new Promise<void>((r) => {
      firstBatch = r;
    });
    // The harness completes only once the first batch has been flushed — the assertion never races the cadence.
    const harness: EvaluableHarness = {
      id: "hold",
      version: "1.0.0",
      install: async () => {},
      run: async function* (): AsyncIterable<TraceEvent> {
        yield { t: 0, kind: "message", role: "assistant", text: "step one" };
        yield { t: 1, kind: "tool_call", id: "t1", name: "bash", args: { cmd: "ls" } };
        await gotBatch;
        yield { t: 2, kind: "message", role: "assistant", text: "done" };
      },
    };

    const result = await runCase(CASE, {
      driver,
      environment: ENVIRONMENT,
      harness,
      graders: [],
      runCtx: {
        apiKeyEnv: {},
        timeoutSec: 60,
        liveTrace: {
          intervalMs: 5,
          report: async (events) => {
            reported.push(...events);
            firstBatch();
          },
        },
      },
    });

    // The final release() flush carries the tail (fire-and-forget) — every drained event reaches the observer,
    // in order; waitFor absorbs the flush's microtask scheduling.
    // The platform's own observation-channel events (Track C) ride the trace too — the tee ordering this
    // test pins is about HARNESS events, so they are filtered like the infra plane below.
    const harnessEvents = () => reported.filter((e) => e.kind !== "env_action");
    await vi.waitFor(() => expect(harnessEvents().map((e) => e.t)).toEqual([0, 1, 2]));
    // The tee never altered the sealed record: the result's own trace still carries the same events.
    expect(result.trace.filter((e) => e.kind !== "infra" && e.kind !== "env_action").map((e) => e.t)).toEqual([
      0, 1, 2,
    ]);
  });

  it("a failing reporter never affects the eval result", async () => {
    const driver = { id: "fake", provision: async () => fakeCompute() } as Driver;
    const harness: EvaluableHarness = {
      id: "quick",
      version: "1.0.0",
      install: async () => {},
      run: async function* (): AsyncIterable<TraceEvent> {
        yield { t: 0, kind: "message", role: "assistant", text: "fine" };
      },
    };

    const result = await runCase(CASE, {
      driver,
      environment: ENVIRONMENT,
      harness,
      graders: [],
      runCtx: {
        apiKeyEnv: {},
        timeoutSec: 60,
        liveTrace: {
          intervalMs: 5,
          report: async () => {
            throw new Error("observer down");
          },
        },
      },
    });
    expect(result.caseId).toBe("c1");
    expect(result.trace.some((e) => e.kind === "message")).toBe(true);
  });
});
