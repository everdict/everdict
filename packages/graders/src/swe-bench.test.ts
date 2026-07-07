import type { ComputeHandle, ExecResult, GradeContext } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { SweBenchGrader } from "./swe-bench.js";

// mock compute: inject git apply / pytest exit codes to verify only the scoring logic deterministically.
function mockCompute(opts: { applyExit?: number; testExit?: number }): { compute: ComputeHandle; cmds: string[] } {
  const cmds: string[] = [];
  const compute: ComputeHandle = {
    async exec(cmd: string): Promise<ExecResult> {
      cmds.push(cmd);
      if (cmd.startsWith("git apply")) return { exitCode: opts.applyExit ?? 0, stdout: "", stderr: "apply" };
      return { exitCode: opts.testExit ?? 0, stdout: "passed", stderr: "" };
    },
    async writeFile() {},
    async readFile() {
      return "";
    },
    async dispose() {},
  };
  return { compute, cmds };
}

const ctxWith = (compute?: ComputeHandle): GradeContext => ({
  case: { id: "i1", env: { kind: "repo", source: { files: {} } }, task: "fix", graders: [], timeoutSec: 1, tags: [] },
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  ...(compute ? { compute } : {}),
});

const cfg = {
  testPatch: "diff --git a/t.py b/t.py\n+test",
  failToPass: ["pkg/test_x.py::test_a"],
  passToPass: ["pkg/test_x.py::test_b"],
};

describe("SweBenchGrader", () => {
  it("test_patch applied + all tests pass → resolved", async () => {
    const { compute, cmds } = mockCompute({ applyExit: 0, testExit: 0 });
    const score = await new SweBenchGrader(cfg).grade(ctxWith(compute));
    expect(score.metric).toBe("resolved");
    expect(score.pass).toBe(true);
    expect(score.value).toBe(1);
    // git apply the gold test_patch, then run F2P+P2P together.
    expect(cmds.some((c) => c.startsWith("git apply"))).toBe(true);
    expect(cmds.some((c) => c.includes("test_a") && c.includes("test_b"))).toBe(true);
  });

  it("test failure (F2P not passing) → unresolved", async () => {
    const { compute } = mockCompute({ applyExit: 0, testExit: 1 });
    const score = await new SweBenchGrader(cfg).grade(ctxWith(compute));
    expect(score.pass).toBe(false);
    expect(String(score.detail)).toContain("UNRESOLVED");
  });

  it("test_patch apply failure → unresolved (scoring impossible)", async () => {
    const { compute, cmds } = mockCompute({ applyExit: 1 });
    const score = await new SweBenchGrader(cfg).grade(ctxWith(compute));
    expect(score.pass).toBe(false);
    expect(String(score.detail)).toContain("test_patch apply failed");
    expect(cmds.some((c) => c.includes("pytest"))).toBe(false); // no test run
  });

  it("errors without compute", async () => {
    await expect(new SweBenchGrader(cfg).grade(ctxWith())).rejects.toThrow(/compute/);
  });
});
