import { BadRequestError, type EvaluableHarness, type Grader, type GraderSpec } from "@assay/core";
import { TestsPassGrader, costGrader, latencyGrader, stepsGrader } from "@assay/graders";
import { ClaudeCodeHarness, ScriptedHarness } from "@assay/harnesses";

// id → 하니스. 에이전트 이미지엔 claude 가 사전설치되므로 install:false.
export function makeHarness(id: string, version: string): EvaluableHarness {
  switch (id) {
    case "claude-code":
      return new ClaudeCodeHarness(version, { install: false });
    case "scripted":
      return new ScriptedHarness(version, () => [{ tool: "bash", cmd: "echo hello > out.txt" }]);
    default:
      throw new BadRequestError("BAD_REQUEST", { harness: id });
  }
}

// GraderSpec[] → Grader[]. tests-pass 는 config.cmd 가 필요하다.
export function makeGraders(specs: GraderSpec[]): Grader[] {
  return specs.map((s) => {
    switch (s.id) {
      case "tests-pass":
        return new TestsPassGrader(String(s.config?.cmd ?? "true"));
      case "steps":
        return stepsGrader;
      case "cost":
        return costGrader;
      case "latency":
        return latencyGrader;
      default:
        throw new BadRequestError("BAD_REQUEST", { grader: s.id });
    }
  });
}
