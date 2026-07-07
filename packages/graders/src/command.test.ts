import type { ComputeHandle, ExecResult, GradeContext } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { CommandGrader } from "./command.js";
import { makeGraders } from "./make-graders.js";

function mockCompute(opts: { applyExit?: number; cmdExit?: number; stdout?: string }): {
  compute: ComputeHandle;
  cmds: string[];
} {
  const cmds: string[] = [];
  const compute: ComputeHandle = {
    async exec(cmd: string): Promise<ExecResult> {
      cmds.push(cmd);
      if (cmd.startsWith("git apply")) return { exitCode: opts.applyExit ?? 0, stdout: "", stderr: "" };
      return { exitCode: opts.cmdExit ?? 0, stdout: opts.stdout ?? "", stderr: "" };
    },
    async writeFile() {},
    async readFile() {
      return "";
    },
    async dispose() {},
  };
  return { compute, cmds };
}

const ctx = (compute?: ComputeHandle): GradeContext => ({
  case: { id: "c", env: { kind: "repo", source: { files: {} } }, task: "fix", graders: [], timeoutSec: 1, tags: [] },
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  ...(compute ? { compute } : {}),
});

describe("CommandGrader (generic test-runner, user-configurable)", () => {
  it("cmd exit code 0 → pass (no patch)", async () => {
    const { compute, cmds } = mockCompute({ cmdExit: 0 });
    const s = await new CommandGrader({ cmd: "pytest -q" }).grade(ctx(compute));
    expect(s.pass).toBe(true);
    expect(cmds.some((c) => c.startsWith("git apply"))).toBe(false); // no git apply without applyPatch
  });

  it("cmd exit code ≠0 → fail", async () => {
    const { compute } = mockCompute({ cmdExit: 1 });
    expect((await new CommandGrader({ cmd: "pytest -q" }).grade(ctx(compute))).pass).toBe(false);
  });

  it("with applyPatch, git apply then run at grading time; fail if apply fails", async () => {
    const ok = mockCompute({ applyExit: 0, cmdExit: 0 });
    expect((await new CommandGrader({ cmd: "pytest", applyPatch: "diff --git a b" }).grade(ctx(ok.compute))).pass).toBe(
      true,
    );
    expect(ok.cmds.some((c) => c.startsWith("git apply"))).toBe(true);
    const bad = mockCompute({ applyExit: 1 });
    const s = await new CommandGrader({ cmd: "pytest", applyPatch: "bad" }).grade(ctx(bad.compute));
    expect(s.pass).toBe(false);
    expect(String(s.detail)).toContain("applyPatch failed");
    expect(bad.cmds.some((c) => c.includes("pytest"))).toBe(false); // no run when apply fails
  });

  it("passPattern matches output (regardless of exit code) + metric/id set", async () => {
    const { compute } = mockCompute({ cmdExit: 1, stdout: "RESULT: ok 12/12" });
    const s = await new CommandGrader({
      cmd: "run",
      passPattern: "ok \\d+/\\d+",
      metric: "resolved",
      id: "mybench",
    }).grade(ctx(compute));
    expect(s.pass).toBe(true); // exit code 1 but pattern matches
    expect(s.metric).toBe("resolved");
    expect(s.graderId).toBe("mybench");
  });

  it("makeGraders spec→grader (user data path)", async () => {
    const { compute } = mockCompute({ cmdExit: 0 });
    const [g] = makeGraders([{ id: "command", config: { cmd: "pytest -q", metric: "resolved" } }]);
    expect(g?.id).toBe("command");
    expect((await g?.grade(ctx(compute)))?.metric).toBe("resolved");
  });

  it("errors without compute", async () => {
    await expect(new CommandGrader({ cmd: "x" }).grade(ctx())).rejects.toThrow(/compute/);
  });
});
