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

describe("CommandGrader (제네릭 테스트-실행, 유저 설정 가능)", () => {
  it("cmd 종료코드 0 → pass (패치 없이)", async () => {
    const { compute, cmds } = mockCompute({ cmdExit: 0 });
    const s = await new CommandGrader({ cmd: "pytest -q" }).grade(ctx(compute));
    expect(s.pass).toBe(true);
    expect(cmds.some((c) => c.startsWith("git apply"))).toBe(false); // applyPatch 없으면 안 함
  });

  it("cmd 종료코드 ≠0 → fail", async () => {
    const { compute } = mockCompute({ cmdExit: 1 });
    expect((await new CommandGrader({ cmd: "pytest -q" }).grade(ctx(compute))).pass).toBe(false);
  });

  it("applyPatch 있으면 채점 시점에 git apply 후 실행; 적용 실패면 fail", async () => {
    const ok = mockCompute({ applyExit: 0, cmdExit: 0 });
    expect((await new CommandGrader({ cmd: "pytest", applyPatch: "diff --git a b" }).grade(ctx(ok.compute))).pass).toBe(
      true,
    );
    expect(ok.cmds.some((c) => c.startsWith("git apply"))).toBe(true);
    const bad = mockCompute({ applyExit: 1 });
    const s = await new CommandGrader({ cmd: "pytest", applyPatch: "bad" }).grade(ctx(bad.compute));
    expect(s.pass).toBe(false);
    expect(String(s.detail)).toContain("applyPatch 실패");
    expect(bad.cmds.some((c) => c.includes("pytest"))).toBe(false); // 적용 실패 시 실행 안 함
  });

  it("passPattern 으로 출력 매칭(종료코드 무관) + metric/id 설정", async () => {
    const { compute } = mockCompute({ cmdExit: 1, stdout: "RESULT: ok 12/12" });
    const s = await new CommandGrader({
      cmd: "run",
      passPattern: "ok \\d+/\\d+",
      metric: "resolved",
      id: "mybench",
    }).grade(ctx(compute));
    expect(s.pass).toBe(true); // 종료코드 1이지만 패턴 매칭
    expect(s.metric).toBe("resolved");
    expect(s.graderId).toBe("mybench");
  });

  it("makeGraders 로 spec→grader (유저 데이터 경로)", async () => {
    const { compute } = mockCompute({ cmdExit: 0 });
    const [g] = makeGraders([{ id: "command", config: { cmd: "pytest -q", metric: "resolved" } }]);
    expect(g?.id).toBe("command");
    expect((await g?.grade(ctx(compute)))?.metric).toBe("resolved");
  });

  it("compute 없으면 에러", async () => {
    await expect(new CommandGrader({ cmd: "x" }).grade(ctx())).rejects.toThrow(/compute/);
  });
});
