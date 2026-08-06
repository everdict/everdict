import type {
  CaseFsAnswer,
  CaseFsRequest,
  ComputeHandle,
  Driver,
  Environment,
  EvalCase,
  EvaluableHarness,
  TraceEvent,
} from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import { runCase } from "./run-case.js";

// The run workbench's self-hosted parity (runCtx.caseFs): runCase answers the control plane's parked repo reads
// from INSIDE the case — the same git commands the managed exec channel runs, executed via compute.exec.

const CASE = { id: "c1", env: { kind: "prompt" }, task: "do it", graders: [], timeoutSec: 60, tags: [] } as EvalCase;

const ENVIRONMENT = {
  seed: async () => {},
  snapshot: async () => ({ kind: "prompt", output: "" }),
} as unknown as Environment;

const TREE_STDOUT = ["a.py", "", "__EVERDICT_FS__", " M a.py", ""].join("\n");

function fakeCompute(execs: string[]): ComputeHandle {
  return {
    exec: async (cmd: string) => {
      execs.push(cmd);
      return { exitCode: 0, stdout: TREE_STDOUT, stderr: "" };
    },
    writeFile: async () => {},
    readFile: async () => "",
    dispose: async () => {},
  } as unknown as ComputeHandle;
}

describe("runCase — run-workbench fs servicing (runCtx.caseFs)", () => {
  it("answers a parked fsTree read from inside the case while the harness runs", async () => {
    const execs: string[] = [];
    const driver = { id: "fake", provision: async () => fakeCompute(execs) } as Driver;
    const answered: Array<{ id: string; result: CaseFsAnswer }> = [];
    let served = (): void => {};
    const gotServed = new Promise<void>((r) => {
      served = r;
    });
    let polled = false;
    // The harness completes only once one request has been served — the assertion never races the cadence.
    const harness: EvaluableHarness = {
      id: "hold",
      version: "1.0.0",
      install: async () => {},
      run: async function* (): AsyncIterable<TraceEvent> {
        yield { t: 0, kind: "message", role: "assistant", text: "working" };
        await gotServed;
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
        caseFs: {
          intervalMs: 5,
          poll: async (): Promise<CaseFsRequest[]> => {
            if (polled) return [];
            polled = true;
            return [{ id: "req-1", kind: "fsTree" }];
          },
          answer: async (id, result) => {
            answered.push({ id, result });
            served();
          },
        },
      },
    });

    await vi.waitFor(() => expect(answered).toHaveLength(1));
    // The git commands ran INSIDE the case, and the answer carries the parsed tree with its status badge.
    expect(execs.some((c) => c.includes("git ls-files"))).toBe(true);
    expect(answered[0]).toEqual({
      id: "req-1",
      result: { kind: "fsTree", tree: { files: [{ path: "a.py", status: "modified" }], truncated: false } },
    });
  });

  it("a failing servicing loop never affects the eval result", async () => {
    const driver = { id: "fake", provision: async () => fakeCompute([]) } as Driver;
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
        caseFs: {
          intervalMs: 5,
          poll: async () => {
            throw new Error("control plane away");
          },
          answer: async () => {
            throw new Error("never called");
          },
        },
      },
    });
    expect(result.caseId).toBe("c1");
  });
});
