import type { EvidenceRequirement, GradeContext, TraceEvent } from "@everdict/contracts";

// The outcome of checking a judge's declared requirements against one run's evidence.
export interface EvidenceAssessment {
  satisfied: EvidenceRequirement[];
  missing: EvidenceRequirement[];
  warnings: string[]; // human-readable reasons a requirement is unmet (drives the ingest-generalization backlog)
}

function hasFinalAnswer(trace: TraceEvent[]): boolean {
  return trace.some((e) => e.kind === "message" && e.role === "assistant" && e.text.length > 0);
}

function hasToolCall(trace: TraceEvent[], name?: string): boolean {
  return trace.some((e) => e.kind === "tool_call" && (name === undefined || e.name === name));
}

// Check a judge's declared evidence requirements against a run's GradeContext. `final_answer`/`tool_call`/`dom`/
// `screenshot` are decidable from today's TraceEvent + snapshot; `artifact`/`span` have no carrier in the current
// TraceEvent, so they read as unmet with a warning that names the ingest-generalization gap (that is the signal).
export function assessEvidence(requires: EvidenceRequirement[], ctx: GradeContext): EvidenceAssessment {
  const satisfied: EvidenceRequirement[] = [];
  const missing: EvidenceRequirement[] = [];
  const warnings: string[] = [];
  const snap = ctx.snapshot;

  for (const req of requires) {
    let ok = false;
    switch (req.kind) {
      case "final_answer":
        ok = hasFinalAnswer(ctx.trace);
        if (!ok) warnings.push("No assistant final answer in the trace.");
        break;
      case "tool_call":
        ok = hasToolCall(ctx.trace, req.name);
        if (!ok)
          warnings.push(req.name ? `No tool_call named "${req.name}" in the trace.` : "No tool_call in the trace.");
        break;
      case "dom":
        ok = snap.kind === "browser" && snap.dom.length > 0;
        if (!ok) warnings.push("This run has no browser DOM snapshot.");
        break;
      case "screenshot":
        ok =
          (snap.kind === "browser" && (Boolean(snap.screenshot) || Boolean(snap.screenshotRef))) ||
          (snap.kind === "os-use" && (snap.screenshot.length > 0 || snap.screenshotRef.length > 0));
        if (!ok) warnings.push("This run carries no screenshot.");
        break;
      case "artifact":
        // No artifact channel in the current TraceEvent — unmet until the ingest generalization adds one.
        warnings.push(
          req.role
            ? `Artifact "${req.role}" is not available: the trace has no artifact channel yet (ingest generalization).`
            : "Artifacts are not available: the trace has no artifact channel yet (ingest generalization).",
        );
        break;
      case "span":
        // Structural spans are dropped at ingest today — unmet until they are preserved.
        warnings.push(
          `Span "${req.name}" is not available: structural spans are dropped at ingest (ingest generalization).`,
        );
        break;
    }
    (ok ? satisfied : missing).push(req);
  }
  return { satisfied, missing, warnings };
}
