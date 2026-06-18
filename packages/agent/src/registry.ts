import { BadRequestError, type EvaluableHarness, type HarnessSpec } from "@assay/core";
import { ClaudeCodeHarness, CommandHarness, ScriptedHarness } from "@assay/harnesses";

// 그레이더 spec→인스턴스 매핑은 @assay/graders 가 소유한다(여기선 재노출).
export { makeGraders } from "@assay/graders";

// id → 하니스. 선언형 command 스펙(컨트롤플레인이 레지스트리에서 풀어 임베드)이 오면 제너릭
// CommandHarness 로 해석한다 — SaaS 유저가 코드 어댑터 없이 CLI 에이전트를 등록할 수 있다.
// 빌트인(claude-code/scripted)은 id 로 분기(에이전트 이미지에 사전설치).
export function makeHarness(id: string, version: string, spec?: HarnessSpec): EvaluableHarness {
  if (spec?.kind === "command") return new CommandHarness(spec);
  switch (id) {
    case "claude-code":
      return new ClaudeCodeHarness(version, { install: false });
    case "scripted":
      return new ScriptedHarness(version, () => [{ tool: "bash", cmd: "echo hello > out.txt" }]);
    default:
      throw new BadRequestError("BAD_REQUEST", { harness: id });
  }
}
