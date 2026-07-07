import {
  BadRequestError,
  type ComputeHandle,
  type EnvSpec,
  type Environment,
  type PromptSnapshot,
} from "@everdict/core";

// Environment-less QA (prompt→answer). With no stage, seed/snapshot are near no-ops — scoring looks at the answer in the trace (answer-match/judge).
// Expresses gsm8k/GAIA-style as first-class rather than routing through repo/browser. (The agent takes the task and produces only an answer.)
export class PromptEnvironment implements Environment<PromptSnapshot> {
  readonly kind = "prompt" as const;

  async seed(_compute: ComputeHandle, spec: EnvSpec): Promise<void> {
    if (spec.kind !== "prompt") throw new BadRequestError("BAD_REQUEST", { kind: spec.kind });
    // There's no environment to seed (prompt only). Context is already reflected in the case task or referenced by the harness.
  }

  async snapshot(_compute: ComputeHandle): Promise<PromptSnapshot> {
    return { kind: "prompt", output: "" }; // no result world — the answer is in the trace.
  }
}
