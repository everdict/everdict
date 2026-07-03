import type { ComputeHandle, ExecResult, GradeContext } from "@assay/core";
import { describe, expect, it } from "vitest";
import { makeGraders } from "./make-graders.js";
import { ScriptScoreGrader } from "./script-score.js";

function mockCompute(stdout: string, exitCode = 0): ComputeHandle {
  return {
    async exec(): Promise<ExecResult> {
      return { exitCode, stdout, stderr: "" };
    },
    async writeFile() {},
    async readFile() {
      return "";
    },
    async dispose() {},
  };
}

const ctx = (compute?: ComputeHandle): GradeContext => ({
  case: { id: "c", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 1, tags: [] },
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  ...(compute ? { compute } : {}),
});

describe("ScriptScoreGrader (제네릭 숫자-점수 grader)", () => {
  it("stdout 의 연속 점수를 value 로 방출하고 임계값으로 pass 판정한다", async () => {
    const s = await new ScriptScoreGrader({ cmd: "run" }).grade(ctx(mockCompute("blah\nSCORE=0.73\n")));
    expect(s.value).toBeCloseTo(0.73);
    expect(s.pass).toBe(true); // 0.73 >= 0.6
  });

  it("점수가 임계값 미만이면 fail (종료코드 0이어도)", async () => {
    const s = await new ScriptScoreGrader({ cmd: "run" }).grade(ctx(mockCompute("SCORE=0.4", 0)));
    expect(s.value).toBeCloseTo(0.4);
    expect(s.pass).toBe(false);
  });

  it("점수를 못 뽑으면 value=0·pass=false 이고 detail 에 명시한다(무성 기본값 아님)", async () => {
    const s = await new ScriptScoreGrader({ cmd: "run" }).grade(ctx(mockCompute("no score here")));
    expect(s.value).toBe(0);
    expect(s.pass).toBe(false);
    expect(String(s.detail)).toContain("점수 미출력");
  });

  it("scorePattern·passThreshold·metric 을 설정할 수 있다", async () => {
    const s = await new ScriptScoreGrader({
      cmd: "run",
      scorePattern: "pinch=([\\d.]+)",
      passThreshold: 0.8,
      metric: "pinch",
    }).grade(ctx(mockCompute("pinch=0.85")));
    expect(s.value).toBeCloseTo(0.85);
    expect(s.pass).toBe(true);
    expect(s.metric).toBe("pinch");
  });

  it("makeGraders 로 spec→grader (유저 데이터 경로)", async () => {
    const [g] = makeGraders([{ id: "script-score", config: { cmd: "run", metric: "pinch" } }]);
    expect(g?.id).toBe("script-score");
    const s = await g?.grade(ctx(mockCompute("SCORE=1.0")));
    expect(s?.metric).toBe("pinch");
    expect(s?.value).toBeCloseTo(1.0);
  });

  it("compute 없으면 에러", async () => {
    await expect(new ScriptScoreGrader({ cmd: "x" }).grade(ctx())).rejects.toThrow(/compute/);
  });
});
