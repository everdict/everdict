import type { ComputeHandle, Driver, Environment, EvalCase, EvaluableHarness, TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { runCase } from "./run-case.js";

const CASE = { id: "c1", env: { kind: "prompt" }, task: "do it", graders: [], timeoutSec: 60, tags: [] } as EvalCase;

const ENVIRONMENT = {
  seed: async () => {},
  snapshot: async () => ({ kind: "prompt", output: "" }),
} as unknown as Environment;

describe("runCase — live-screen capture (runCtx.liveScreen)", () => {
  // A compute whose exec returns a distinct base64 frame for the capture command and records every command it ran.
  function captureCompute(): ComputeHandle & { disposed: boolean; execCalls: string[] } {
    const handle = {
      disposed: false,
      execCalls: [] as string[],
      exec: async (command: string) => {
        handle.execCalls.push(command);
        return command === "shot"
          ? { exitCode: 0, stdout: "AAAAframe", stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "" };
      },
      writeFile: async () => {},
      readFile: async () => "",
      dispose: async () => {
        handle.disposed = true;
      },
    };
    return handle;
  }

  it("execs the capture command while the harness runs, reports frames, and stops before the compute is disposed", async () => {
    const compute = captureCompute();
    const driver = { id: "fake", provision: async () => compute } as Driver;
    const reported: string[] = [];
    let firstFrame = (): void => {};
    const gotFrame = new Promise<void>((r) => {
      firstFrame = r;
    });
    // The harness completes only once a frame has been captured+reported — so the assertion never races the loop.
    const harness: EvaluableHarness = {
      id: "hold",
      version: "1.0.0",
      install: async () => {},
      run: async function* (): AsyncIterable<TraceEvent> {
        yield { t: 0, kind: "log", text: "begin", stream: "stdout" } as TraceEvent;
        await gotFrame;
      },
    };

    await runCase(CASE, {
      driver,
      environment: ENVIRONMENT,
      harness,
      graders: [],
      runCtx: {
        apiKeyEnv: {},
        timeoutSec: 60,
        liveScreen: {
          captureCmd: "shot",
          intervalMs: 5,
          report: async (frame) => {
            reported.push(frame);
            firstFrame();
          },
        },
      },
    });

    expect(reported).toContain("AAAAframe"); // a live frame was captured and pushed to the reporter
    expect(compute.disposed).toBe(true);
    // The loop is halted in release() before dispose — no capture command runs after the run ends.
    const shotsAtEnd = compute.execCalls.filter((c) => c === "shot").length;
    await new Promise((r) => setTimeout(r, 30)); // several intervals
    expect(compute.execCalls.filter((c) => c === "shot").length).toBe(shotsAtEnd);
  });

  it("never runs the capture command when no liveScreen hook is set", async () => {
    const compute = captureCompute();
    const driver = { id: "fake", provision: async () => compute } as Driver;
    const harness: EvaluableHarness = {
      id: "quick",
      version: "1.0.0",
      install: async () => {},
      run: async function* (): AsyncIterable<TraceEvent> {
        yield { t: 0, kind: "log", text: "done", stream: "stdout" } as TraceEvent;
      },
    };

    await runCase(CASE, {
      driver,
      environment: ENVIRONMENT,
      harness,
      graders: [],
      runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
    });
    expect(compute.execCalls).not.toContain("shot");
  });
});
