import { BadRequestError, type EvaluableHarness } from "@assay/core";
import { ClaudeCodeHarness, ScriptedHarness } from "@assay/harnesses";

// 그레이더 spec→인스턴스 매핑은 @assay/graders 가 소유한다(여기선 재노출).
export { makeGraders } from "@assay/graders";

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
