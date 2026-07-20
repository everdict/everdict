import type { GradeContext, JudgeSpec, Placement, Score } from "@everdict/contracts";

// Judge runner PORT — JudgeSpec + tenant + GradeContext (trace) → Score[]. The control plane judges from the trace.
// The default impl (defaultJudgeRunner) wires the graders transports (anthropic/openai/harness) and lives in apps/api
// infrastructure — it composes @everdict/graders values, which application-control must not import. ScoringService
// depends on this interface only. Moved here in re-architecture P2 S3 (the impl kept the skip-valve).
export interface JudgeRunner {
  // placement = the source run's placement (where the observations are). A harness judge prefers spec.runtime, else inherits this (co-locate).
  // submittedBy = the producing run's submitter subject — code/harness judges dispatch a wrapper job, and a co-located
  // self-hosted target (self:<runnerId>) resolves its owner from submittedBy; dropping it makes that dispatch fail the
  // ownership check and the judge skip. Undefined on the ingest path (no producing run / no self-hosted co-locate).
  run(
    spec: JudgeSpec,
    tenant: string,
    ctx: GradeContext,
    placement?: Placement,
    submittedBy?: string,
  ): Promise<Score[]>;
}
