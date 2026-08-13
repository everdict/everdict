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

function hasArtifact(trace: TraceEvent[], role?: string): boolean {
  return trace.some((e) => e.kind === "artifact" && (role === undefined || e.role === role));
}

function hasSpan(trace: TraceEvent[], name: string): boolean {
  return trace.some((e) => e.kind === "span" && e.name === name);
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
        ok = hasArtifact(ctx.trace, req.role);
        if (!ok)
          warnings.push(req.role ? `No artifact with role "${req.role}" in the trace.` : "No artifact in the trace.");
        break;
      case "span":
        ok = hasSpan(ctx.trace, req.name);
        if (!ok) warnings.push(`No structural span named "${req.name}" in the trace.`);
        break;
    }
    (ok ? satisfied : missing).push(req);
  }
  return { satisfied, missing, warnings };
}

// ── A DECLARED REQUIREMENT IS DELIVERED, NOT HOPED FOR ───────────────────────────────────────────────
//
// `requires` used to be a preview-only annotation: it told a user, before committing, whether the target
// harness produces the evidence — and then the real grade ignored it. So the evidence a judge said it needs
// reached the model only if it happened to survive inside the trace JSON, which is serialized whole and cut
// at a character budget. On a long browser run the required `tool_call` sat past the cut, and the judge
// answered anyway: a confident verdict rendered on evidence that was not in the prompt.
//
// So every satisfied requirement is HOISTED into its own section (rendered before the trace, so truncation
// cannot reach it), and the unsatisfied ones are what the caller refuses on. `final_answer`, `dom` and
// `screenshot` are omitted here because each already has a dedicated section of its own — hoisting them
// again would just duplicate the evidence inside its own prompt.
export interface HoistedEvidence {
  label: string;
  text: string;
}

export function hoistRequiredEvidence(requires: EvidenceRequirement[], trace: TraceEvent[]): HoistedEvidence[] {
  const out: HoistedEvidence[] = [];
  for (const req of requires) {
    if (req.kind === "tool_call") {
      const events = trace.filter((e) => e.kind === "tool_call" && (req.name === undefined || e.name === req.name));
      if (events.length > 0)
        out.push({ label: req.name ? `REQUIRED TOOL CALLS (${req.name})` : "REQUIRED TOOL CALLS", text: json(events) });
    } else if (req.kind === "artifact") {
      const events = trace.filter((e) => e.kind === "artifact" && (req.role === undefined || e.role === req.role));
      if (events.length > 0)
        out.push({ label: req.role ? `REQUIRED ARTIFACTS (${req.role})` : "REQUIRED ARTIFACTS", text: json(events) });
    } else if (req.kind === "span") {
      const events = trace.filter((e) => e.kind === "span" && e.name === req.name);
      if (events.length > 0) out.push({ label: `REQUIRED SPAN (${req.name})`, text: json(events) });
    }
  }
  return out;
}

function json(events: TraceEvent[]): string {
  return JSON.stringify(events);
}
