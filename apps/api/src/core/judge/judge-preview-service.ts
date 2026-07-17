import type { JudgeRunner } from "@everdict/application-control";
import {
  BadRequestError,
  type EnvSnapshot,
  type EvalCase,
  type GradeContext,
  type JudgeSpec,
  NotFoundError,
  type RunRecord,
  type Score,
  type TraceEvent,
  type TraceEvidence,
} from "@everdict/contracts";
import {
  type EvidenceAssessment,
  type JudgePreview,
  assembleJudgeInput,
  assessEvidence,
  previewJudge,
  withCaseMilestones,
} from "@everdict/graders";
import type { RubricRegistry } from "@everdict/registry";
import { resolveRubric } from "../execution/judge-runner.js";

// Sample evidence to preview/dry-run a judge over — resolves to ONE GradeContext.
// - "trace" (source B): a pasted/uploaded trace + a synthetic environment-free snapshot (+ optionally the
//   extracted mapping evidence, which carries CUSTOM template slots exactly as the pull path does).
// - "run"   (source A): a real prior standalone run's stored trace+snapshot+EvalCase (re-score).
export type JudgeEvidenceInput =
  | {
      source: "trace";
      trace: TraceEvent[];
      task?: string;
      expected?: string;
      snapshot?: EnvSnapshot;
      traceEvidence?: TraceEvidence;
    }
  | { source: "run"; runId: string };

// A preview = the exact prompt + coverage the judge would see, plus any rubric-resolution warning. No model call.
export interface JudgePreviewResult extends JudgePreview {
  kind: JudgeSpec["kind"];
  requirements?: EvidenceAssessment; // present when the judge declares `requires` — which needs are met by this run
}

// A dry-run = the real judge scores (one model call) PLUS the rendered prompt/coverage for transparency.
export interface JudgeTryResult extends JudgePreviewResult {
  scores: Score[];
}

export interface JudgePreviewServiceDeps {
  rubrics?: RubricRegistry; // resolve a {id, version} rubric ref exactly as a real grade does (own fields override)
  judgeRunner?: JudgeRunner; // dry-run (try) transport — actually runs the judge (one model call). Absent → try disabled.
  getRun?: (tenant: string, runId: string) => Promise<RunRecord | undefined>; // source "run" — workspace-scoped
}

export interface PreviewCommand {
  tenant: string;
  spec: JudgeSpec;
  evidence: JudgeEvidenceInput;
}

// Build a GradeContext from a pasted trace + a synthetic, environment-free prompt snapshot (unless one is provided).
export function gradeContextFromTrace(evidence: Extract<JudgeEvidenceInput, { source: "trace" }>): GradeContext {
  return {
    case: {
      id: "preview",
      env: { kind: "prompt" },
      task: evidence.task ?? "(preview)",
      graders: [],
      timeoutSec: 1,
      tags: [],
      ...(evidence.expected ? { expected: evidence.expected } : {}),
    },
    trace: evidence.trace,
    snapshot: evidence.snapshot ?? { kind: "prompt", output: "" },
    ...(evidence.traceEvidence ? { evidence: evidence.traceEvidence } : {}),
  };
}

// Zero-cost preview + one-case dry-run of what a judge sees on given evidence — the registration wizard and previews.
export class JudgePreviewService {
  constructor(private readonly deps: JudgePreviewServiceDeps) {}

  // Resolve any evidence source to the ONE GradeContext all surfaces judge over.
  private async loadContext(tenant: string, evidence: JudgeEvidenceInput): Promise<GradeContext> {
    if (evidence.source === "trace") return gradeContextFromTrace(evidence);
    // source === "run" — re-score a real prior standalone run (workspace-scoped; cross-workspace/missing → 404).
    if (!this.deps.getRun) throw new BadRequestError("BAD_REQUEST", {}, "run re-score is not configured");
    const record = await this.deps.getRun(tenant, evidence.runId);
    if (!record) throw new NotFoundError("NOT_FOUND", { runId: evidence.runId }, "run not found");
    if (!record.result)
      throw new BadRequestError("BAD_REQUEST", { runId: evidence.runId }, "run has no result to re-score yet");
    // caseSpec is present for standalone runs (mig 0051); a batch child re-plans from its dataset, so synthesize a minimal case.
    const evalCase: EvalCase = record.caseSpec ?? {
      id: record.caseId,
      env: { kind: "prompt" },
      task: "(unknown — batch child run)",
      graders: [],
      timeoutSec: 1,
      tags: [],
    };
    return {
      case: evalCase,
      trace: record.result.trace,
      snapshot: record.result.snapshot,
      ...(record.result.evidence ? { evidence: record.result.evidence } : {}),
    };
  }

  // Resolve the rubric via the SAME path a real grade uses, then render the prompt + coverage (no model call).
  private async render(tenant: string, spec: JudgeSpec, ctx: GradeContext): Promise<JudgePreviewResult> {
    // code judge — there is no prompt to render (the code builds its own calls); the preview is the evidence
    // coverage the code will receive plus the declared-requirement check. "Run once" (try) is the real preview.
    if (spec.kind === "code") {
      const input = await assembleJudgeInput(ctx, {});
      const preview = previewJudge(input);
      const requirements = spec.requires?.length ? assessEvidence(spec.requires, ctx) : undefined;
      return {
        kind: spec.kind,
        prompt: "",
        evidence: preview.evidence,
        warnings: [],
        ...(requirements ? { requirements } : {}),
      };
    }
    const resolution = await resolveRubric(this.deps.rubrics, tenant, spec);
    const rubricWarning = "skipReason" in resolution ? resolution.skipReason : undefined;
    const effective =
      "skipReason" in resolution
        ? {
            ...(spec.criteria?.length ? { criteria: spec.criteria } : {}),
            ...(spec.promptTemplate ? { promptTemplate: spec.promptTemplate } : {}),
          }
        : resolution.effective;

    const useScreenshot = spec.kind === "model" && (spec.inputs ?? []).includes("screenshot");
    // The case's milestones merge into the criteria exactly as JudgeGrader.grade does — the preview's prompt
    // must stay byte-identical to a real grade (re-scored runs carry milestones via their stored caseSpec).
    const criteria = withCaseMilestones(effective.criteria, ctx.case);
    const input = await assembleJudgeInput(ctx, {
      ...(effective.rubricText ? { rubric: effective.rubricText } : {}),
      ...(criteria?.length ? { criteria } : {}),
      ...(effective.promptTemplate ? { promptTemplate: effective.promptTemplate } : {}),
      ...(useScreenshot ? { useScreenshot: true } : {}),
    });
    const preview = previewJudge(input);
    // If the judge declares required evidence, check it against THIS run — the missing set is what the user must
    // fix (a different harness, or the ingest generalization) before this judge is sound on this evidence.
    const requirements = spec.requires?.length ? assessEvidence(spec.requires, ctx) : undefined;
    return {
      kind: spec.kind,
      ...preview,
      warnings: rubricWarning ? [`rubric: ${rubricWarning}`, ...preview.warnings] : preview.warnings,
      ...(requirements ? { requirements } : {}),
    };
  }

  // Zero model-call preview — render the exact prompt + coverage for a (draft) judge against sample evidence.
  async preview(cmd: PreviewCommand): Promise<JudgePreviewResult> {
    const ctx = await this.loadContext(cmd.tenant, cmd.evidence);
    return this.render(cmd.tenant, cmd.spec, ctx);
  }

  // One-case dry-run — actually run the judge (one model call) over sample evidence via the SAME JudgeRunner a
  // scorecard uses, and return its scores alongside the rendered prompt. A skip (no key/unresolved) surfaces as a
  // skip Score with a stated reason (never a silent failure), exactly as in a real batch.
  async try(cmd: PreviewCommand): Promise<JudgeTryResult> {
    if (!this.deps.judgeRunner) throw new BadRequestError("BAD_REQUEST", {}, "judge dry-run is not configured");
    const ctx = await this.loadContext(cmd.tenant, cmd.evidence);
    const rendered = await this.render(cmd.tenant, cmd.spec, ctx);
    const scores = await this.deps.judgeRunner.run(cmd.spec, cmd.tenant, ctx);
    return { ...rendered, scores };
  }
}
