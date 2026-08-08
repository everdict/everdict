import {
  BadRequestError,
  type CaseResult,
  type Dataset,
  type EvalCase,
  type GraderSpec,
  type Score,
  type ScorecardSubset,
  isMeasured,
  measuredScores,
} from "@everdict/contracts";

// Pure scoring-plan semantics, moved from application-control's scorecard-shared (review §22): grading-plan
// application, subset selection, the (case, trial) child key, judge-metric ownership and the case-reason
// read are decisions over contract types with no I/O — domain kernel by the layering's own definition, and
// both scoring paths (in-process + Temporal) must stand on ONE implementation of each.

// Child-run key for a (case, trial) pair — a batch with trials>1 fans N children per case, so caseId alone is
// ambiguous. trial absent (single-run) collapses to "<caseId>#0", so single-run keying is byte-identical.
// docs/architecture/trial-based-verdict.md
export function childKey(caseId: string, trial?: number): string {
  return `${caseId}#${trial ?? 0}`;
}

// ── Judge-metric ownership (one predicate for BOTH scoring paths) ────────────────────────────────────────
// A judge's scores live under `judge:<id>` (the verdict) and `judge:<id>:<criterion>` (diagnostic children).
// The in-process pass and the Temporal pass used to answer "is this case already judged?" and "which rows
// does a re-score replace?" DIFFERENTLY — the Temporal side read bare metric PRESENCE as "judged", so an
// unmeasured placeholder row (the very thing rescore-unmeasured exists to recover) made it skip exactly the
// cases it was invoked for, and its strip missed the criterion children so stale diagnostics compounded on
// every pass. Both paths now stand on these three.
export function isJudgeMetricOf(metric: string, judgeId: string): boolean {
  return metric === `judge:${judgeId}` || metric.startsWith(`judge:${judgeId}:`);
}

// "Already judged" = a MEASURED top-level verdict exists. An unmeasured/invalid placeholder is a recorded
// failure to judge, never a verdict — it must leave the case eligible for the pass that replaces it.
export function hasMeasuredJudgeVerdict(result: Pick<CaseResult, "scores">, judgeId: string): boolean {
  return result.scores.some((s) => s.metric === `judge:${judgeId}` && isMeasured(s));
}

// Strip EVERYTHING the selected judges previously wrote — verdicts, criterion children, placeholders — so a
// re-score replaces its own output wholesale instead of accreting duplicates next to stale rows.
export function stripJudgeScores(scores: Score[], judges: ReadonlyArray<{ id: string }>): Score[] {
  return scores.filter((s) => !judges.some((j) => isJudgeMetricOf(s.metric, j.id)));
}

// Progress-step failure/verdict reason — prefer a trace error event over a pass:false score.detail. Carried verbatim
// so the live "Progress" timeline shows the WHOLE error (the web clamps it to a few lines with an expand toggle rather
// than cutting it), bounded only to keep the steps jsonb from exploding on a batch of long-erroring cases — a full
// stack trace beyond the cap still lives untruncated on the per-case result. Was 140 (cut mid-sentence — unreadable).
const CASE_REASON_MAX = 2000;
export function caseReason(r: CaseResult): string | undefined {
  const errEvent = r.trace.find((e) => e.kind === "error");
  const raw =
    errEvent && "message" in errEvent
      ? errEvent.message
      : measuredScores(r.scores).find((s) => s.pass === false && typeof s.detail === "string")?.detail;
  if (typeof raw !== "string" || raw === "") return undefined;
  return raw.length > CASE_REASON_MAX ? `${raw.slice(0, CASE_REASON_MAX)}…` : raw;
}

// Partial-run selection — apply ids (explicit) → tags (any-match) → limit (first N) in order. Pure function (easy to test).
// A nonexistent id silently yielding an empty result would be a "ran a subset but looks like the whole thing" hazard, so reject immediately with 400.
export function selectSubsetCases(
  dataset: Dataset,
  sel?: { ids?: string[]; tags?: string[]; limit?: number },
): { cases: Dataset["cases"]; subset?: ScorecardSubset } {
  if (!sel || (!sel.ids?.length && !sel.tags?.length && sel.limit === undefined)) return { cases: dataset.cases };
  let cases = dataset.cases;
  if (sel.ids && sel.ids.length > 0) {
    const want = new Set(sel.ids);
    const have = new Set(cases.map((c) => c.id));
    const missing = [...want].filter((id) => !have.has(id));
    if (missing.length > 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { dataset: dataset.id, missing },
        `Case ids not in the dataset: ${missing.join(", ")}`,
      );
    cases = cases.filter((c) => want.has(c.id));
  }
  if (sel.tags && sel.tags.length > 0) {
    const want = new Set(sel.tags);
    cases = cases.filter((c) => (c.tags ?? []).some((t) => want.has(t)));
  }
  if (sel.limit !== undefined) cases = cases.slice(0, sel.limit);
  if (cases.length === 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { dataset: dataset.id, ...sel },
      "No cases match the selection (check tags/limit).",
    );
  return {
    cases,
    subset: {
      total: dataset.cases.length,
      selected: cases.length,
      ...(sel.ids && sel.ids.length > 0 ? { ids: sel.ids } : {}),
      ...(sel.tags && sel.tags.length > 0 ? { tags: sel.tags } : {}),
      ...(sel.limit !== undefined ? { limit: sel.limit } : {}),
    },
  };
}

// Run-time grading plan (docs/architecture/eval-domain-model.md S5) — overrides EVERY case's default graders for
// this batch only, so re-scoring a dataset differently never edits the dataset. Pure function; applied at submit
// AND at every re-materialization point (resume / retry-failed / Temporal planBatch) from the persisted orchestration.
export function applyGradingPlan(cases: EvalCase[], plan?: GraderSpec[]): EvalCase[] {
  if (!plan || plan.length === 0) return cases;
  return cases.map((c) => ({ ...c, graders: plan }));
}
