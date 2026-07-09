import { type ComputeHandle, type ExecResult, type GradeContext, toScores } from "@everdict/core";
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

describe("ScriptScoreGrader (generic numeric-score grader)", () => {
  it("emits the continuous score from stdout as value and decides pass by the threshold", async () => {
    const s = await new ScriptScoreGrader({ cmd: "run" }).grade(ctx(mockCompute("blah\nSCORE=0.73\n")));
    expect(s.value).toBeCloseTo(0.73);
    expect(s.pass).toBe(true); // 0.73 >= 0.6
  });

  it("fails when the score is below the threshold (even with exit code 0)", async () => {
    const s = await new ScriptScoreGrader({ cmd: "run" }).grade(ctx(mockCompute("SCORE=0.4", 0)));
    expect(s.value).toBeCloseTo(0.4);
    expect(s.pass).toBe(false);
  });

  it("value=0·pass=false and noted in detail when no score can be extracted (not a silent default)", async () => {
    const s = await new ScriptScoreGrader({ cmd: "run" }).grade(ctx(mockCompute("no score here")));
    expect(s.value).toBe(0);
    expect(s.pass).toBe(false);
    expect(String(s.detail)).toContain("no score printed");
  });

  it("scorePattern·passThreshold·metric can be configured", async () => {
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

  it("makeGraders spec→grader (user data path)", async () => {
    const [g] = makeGraders([{ id: "script-score", config: { cmd: "run", metric: "pinch" } }]);
    expect(g?.id).toBe("script-score");
    const [s] = toScores((await g?.grade(ctx(mockCompute("SCORE=1.0")))) ?? []);
    expect(s?.metric).toBe("pinch");
    expect(s?.value).toBeCloseTo(1.0);
  });

  it("errors without compute", async () => {
    await expect(new ScriptScoreGrader({ cmd: "x" }).grade(ctx())).rejects.toThrow(/compute/);
  });
});
