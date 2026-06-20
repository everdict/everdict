import { BadRequestError, type ComputeHandle, type EnvSpec, type Environment, type PromptSnapshot } from "@assay/core";

// 환경 없는 QA(프롬프트→답). 무대가 없어 seed/snapshot 은 no-op 에 가깝다 — 채점은 trace 의 답을 본다(answer-match/judge).
// gsm8k/GAIA 류를 repo/browser 로 우회하지 않고 1급으로 표현. (에이전트가 task 를 받아 답만 만든다.)
export class PromptEnvironment implements Environment<PromptSnapshot> {
  readonly kind = "prompt" as const;

  async seed(_compute: ComputeHandle, spec: EnvSpec): Promise<void> {
    if (spec.kind !== "prompt") throw new BadRequestError("BAD_REQUEST", { kind: spec.kind });
    // 시드할 환경이 없다(프롬프트만). context 는 케이스 task 에 이미 반영되거나 하니스가 참고.
  }

  async snapshot(_compute: ComputeHandle): Promise<PromptSnapshot> {
    return { kind: "prompt", output: "" }; // 결과 세계 없음 — 답은 trace 에.
  }
}
