import type { EnvSnapshot, GradeContext, JudgeSpec, TraceEvent } from "@everdict/contracts";
import { type JudgePreview, assembleJudgeInput, previewJudge } from "@everdict/graders";
import type { RubricRegistry } from "@everdict/registry";
import { resolveRubric } from "../execution/judge-runner.js";

// Sample evidence to preview/dry-run a judge over — resolves to ONE GradeContext. S2 = the "trace" (paste) source.
export type JudgeEvidenceInput = {
  source: "trace";
  trace: TraceEvent[];
  task?: string;
  expected?: string;
  snapshot?: EnvSnapshot;
};

// A preview = the exact prompt + coverage the judge would see, plus any rubric-resolution warning. No model call.
export interface JudgePreviewResult extends JudgePreview {
  kind: JudgeSpec["kind"];
}

export interface JudgePreviewServiceDeps {
  rubrics?: RubricRegistry; // resolve a {id, version} rubric ref exactly as a real grade does (own fields override)
}

export interface PreviewCommand {
  tenant: string;
  spec: JudgeSpec;
  evidence: JudgeEvidenceInput;
}

// Build the GradeContext a judge scores over from sample evidence. S2: a pasted/uploaded trace + a synthetic,
// environment-free prompt snapshot (unless a snapshot is provided). S3 adds run/scorecard re-score + live dispatch.
export function gradeContextFromEvidence(evidence: JudgeEvidenceInput): GradeContext {
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
  };
}

// Zero-cost preview of what a judge would see on given evidence — used by the registration wizard and previews.
export class JudgePreviewService {
  constructor(private readonly deps: JudgePreviewServiceDeps) {}

  async preview(cmd: PreviewCommand): Promise<JudgePreviewResult> {
    const { tenant, spec, evidence } = cmd;
    const ctx = gradeContextFromEvidence(evidence);

    // Resolve the rubric via the SAME path a real grade uses. On an unresolved ref, fall back to the judge's own
    // fields and surface the reason as a warning (the wizard still renders — never a silent empty preview).
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
    const input = await assembleJudgeInput(ctx, {
      ...(effective.rubricText ? { rubric: effective.rubricText } : {}),
      ...(effective.criteria?.length ? { criteria: effective.criteria } : {}),
      ...(effective.promptTemplate ? { promptTemplate: effective.promptTemplate } : {}),
      ...(useScreenshot ? { useScreenshot: true } : {}),
    });

    const preview = previewJudge(input);
    return {
      kind: spec.kind,
      ...preview,
      warnings: rubricWarning ? [`rubric: ${rubricWarning}`, ...preview.warnings] : preview.warnings,
    };
  }
}
