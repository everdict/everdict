import {
  BadRequestError,
  type CaseResult,
  type Dataset,
  type EvalCase,
  type GraderSpec,
  type Score,
  type ScorecardManifest,
  type ScorecardSubset,
  isMeasured,
  measuredScores,
} from "@everdict/contracts";
import { contentDigest } from "../provenance/content-digest.js";

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

// How far a JUDGE has got on one case, from the ORCHESTRATION's point of view — a different question from
// "is there a verdict", and conflating the two is what made a scoring pass unable to finish (arch-review 11).
//
// `hasMeasuredJudgeVerdict` answers the MEASUREMENT question and answers it correctly: an unmeasured row is a
// recorded failure to judge, never a verdict. The planner read that same boolean as "still to do" — so a
// judge that can NEVER produce a verdict on this case (its spec was deleted, so every attempt writes
// `reason: "unsupported", retryable: false`) stayed on the worklist forever. Inside one workflow execution
// that is merely wasted calls; across `continueAsNew` it is a loop, because each continuation re-plans from
// the plane and selects the same cases again. Judge calls are provider calls, so the loop bills.
//
//   absent               → nothing has been attempted; run it
//   retryable_unmeasured → attempted and recoverable; run it, but not forever (see `attempts`)
//   terminal_unmeasured  → attempted and NOT recoverable in place. The orchestration is DONE with this case:
//                          the fix is configuration plus a NEW pass, which is exactly what the producer's own
//                          `retryable: false` already says. The case still carries no verdict, and every
//                          measurement surface keeps reading it that way.
//   measured             → a verdict exists
//
// The attempt budget is PASS-LOCAL for free: a pass strips the selected judges' rows before it starts, so the
// counter it reads is one this pass wrote. A new pass begins at zero without anyone resetting anything.
export type JudgeProgress = "absent" | "retryable_unmeasured" | "terminal_unmeasured" | "measured";

// How many times one pass re-attempts a RETRYABLE unmeasured judgment before treating it as terminal. A
// transient judge outage deserves another go; a judge that fails the same way five times in one pass is not
// transient, and the pass has to be able to end.
export const MAX_JUDGE_ATTEMPTS_PER_PASS = 3;

export function judgeProgress(
  result: Pick<CaseResult, "scores">,
  judgeId: string,
  maxAttempts: number = MAX_JUDGE_ATTEMPTS_PER_PASS,
): JudgeProgress {
  const verdict = result.scores.find((s) => s.metric === `judge:${judgeId}`);
  if (verdict === undefined) return "absent";
  if (isMeasured(verdict)) return "measured";
  // An INVALID row is a grader CONTRACT VIOLATION — a bug in the judge's output shape, not a transient
  // condition. Re-running produces the same violation, so the orchestration is done with it; the fix is a
  // code change and then a new pass, which is the same recovery `retryable: false` describes.
  if (verdict.status === "invalid") return "terminal_unmeasured";
  // Unmeasured. The producer's own `retryable` flag decides — never a re-derivation from the reason string,
  // which is how the two vocabularies would drift apart.
  if (verdict.retryable !== true) return "terminal_unmeasured";
  return (verdict.attempts ?? 0) >= maxAttempts ? "terminal_unmeasured" : "retryable_unmeasured";
}

// WHICH of the selected judges still have work on this case — the unit completion is decided in, and
// therefore the unit a retry is allowed to touch (arch-review 12).
//
// The boolean version below answers "is this case pending", which is what a PLANNER needs. It is not what an
// EXECUTOR needs, and using it for both put the two out of step: `scoreCase` stripped and re-ran EVERY
// selected judge because ONE of them was pending. So a case with judge A measured and judge B retrying
// deleted A's verdict and paid for a second A call — and worse, a judge already declared
// `terminal_unmeasured` was re-invoked, which is the exact statement the type was introduced to make
// impossible. Completion granularity and mutation granularity have to be the same unit, or the invariant
// only describes what the planner believes.
export function pendingJudgesFor<J extends { id: string }>(
  result: Pick<CaseResult, "scores">,
  judges: readonly J[],
  maxAttempts: number = MAX_JUDGE_ATTEMPTS_PER_PASS,
): J[] {
  return judges.filter((j) => {
    const progress = judgeProgress(result, j.id, maxAttempts);
    return progress === "absent" || progress === "retryable_unmeasured";
  });
}

// WHICH JUDGE IDS APPEAR TWICE in a selection (arch-review 16 P1-7).
//
// A judge OWNS a metric family — `judge:<id>` plus its `judge:<id>:<criterion>` children — and every
// mechanism below is keyed the same way: `pendingJudgesFor`, `stripJudgeScores`, the attempt budget, and the
// scoring stage's natural key (case, judgeId). Two versions of ONE judge in a single selection is therefore
// not a richer request, it is a state the plane cannot represent: they would write the same metric family,
// claim the same stage row, and a Postgres upsert whose statement carries the same conflict key twice fails
// outright. Uniqueness is by ID, never by (id, version), because the id is what owns the family.
// …and the family predicate is only unambiguous because a judge id may not contain `:` (arch-review 17 P1-4,
// enforced on JudgeSpec). With ids `foo` and `foo:bar` both legal, `judge:foo:bar` would be at once a
// criterion of `foo` and the top-level verdict of `foo:bar` — so re-scoring `foo` would strip `foo:bar`'s
// verdict. The separator is reserved at the boundary precisely so this predicate can stay simple.
export function duplicateJudgeIds(judges: ReadonlyArray<{ id: string }>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const judge of judges) {
    if (seen.has(judge.id)) duplicates.add(judge.id);
    seen.add(judge.id);
  }
  return [...duplicates].sort();
}

// Does this case still have work for THIS pass? The PLANNER's predicate — "should this case be on the
// worklist at all". The executor narrows further with `pendingJudgesFor`.
export function judgePending(
  result: Pick<CaseResult, "scores">,
  judges: ReadonlyArray<{ id: string }>,
  maxAttempts: number = MAX_JUDGE_ATTEMPTS_PER_PASS,
): boolean {
  return pendingJudgesFor(result, judges, maxAttempts).length > 0;
}

// Carry the pass's attempt count onto the judgments it just produced. Called after a case is judged and
// BEFORE the write-back, with the attempts the case carried going in — a re-score strips the judge family
// first, so without this the counter resets on every attempt and the budget never binds.
export function stampJudgeAttempts(
  scores: Score[],
  judges: ReadonlyArray<{ id: string }>,
  priorAttempts: ReadonlyMap<string, number>,
): Score[] {
  return scores.map((s) => {
    // ONLY the `unmeasured` variant carries a counter. A measured verdict ended the counting, and the
    // `invalid` variant's schema is strict — stamping a field it does not declare would make the next parse
    // of this row throw, turning a retry budget into a deserialization failure.
    if (s.status !== "unmeasured") return s;
    const judge = judges.find((j) => s.metric === `judge:${j.id}`);
    if (judge === undefined) return s;
    return { ...s, attempts: (priorAttempts.get(judge.id) ?? 0) + 1 };
  });
}

// What each selected judge had already tried on this case, read BEFORE the strip.
export function judgeAttemptsOf(
  result: Pick<CaseResult, "scores">,
  judges: ReadonlyArray<{ id: string }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const j of judges) {
    const verdict = result.scores.find((s) => s.metric === `judge:${j.id}`);
    // Only the `unmeasured` variant counts attempts — a measured verdict ended the counting, and an invalid
    // one is a grader bug the orchestration is already done with.
    if (verdict?.status === "unmeasured") out.set(j.id, verdict.attempts ?? 0);
  }
  return out;
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

// THE EFFECTIVE GRADING SEMANTICS — what the batch will actually be graded by (arch-review 21 P0-2).
//
// A DECLARATION IS NOT PART OF THE CONSTITUTION UNTIL THE DECISION FUNCTION THAT CONSUMES THE MEASUREMENT
// ALSO CONSUMES THAT DECLARATION.
//
// The verdict policy was composed from the REQUEST's grading plan alone, so a `GraderSpec.metrics[]`
// declaration living in the dataset — the normal case, and the one every product watch series runs — reached
// `makeGraders` (which granted the grader the right to emit the metric) and never reached the policy. The
// consequence is not cosmetic: `evaluateVerdict` excludes a metric the policy calls OBSERVATIONAL, and falls
// back to deciding on any measured metric it has never heard of. So a dataset saying "toxicity is
// observational" produced a batch in which toxicity DECIDED the case — the declaration inverted by being
// ignored, in the direction of a verdict nobody asked for.
//
// The fix is to read the semantics off the EFFECTIVE cases rather than the transport field that happened to
// override them. `applyGradingPlan` has already replaced each case's graders with the plan when one exists,
// so one rule covers both paths: whatever will grade is what declares.
//
// Two cases declaring DIFFERENT semantics for one metric is refused rather than resolved. Picking by
// declaration order would make a batch's constitution depend on case ordering, and there is no honest
// tie-break: the two declarations disagree about what the measurement MEANS.
// WHICH metrics a set of cases declares GROUND TRUTH for — the constitutional act, wherever it is written
// (arch-review 22 P0-2).
//
// Declaring ground truth redefines what passing means: `evaluateVerdict` ranks ground_truth above objective,
// so a custom `business_ok: true` decides a case that a built-in `tests_pass: false` would otherwise fail.
// That is a grant of new authority, not a description of an existing one — the earlier reading ("a measured
// metric already decided the case through the fallback") holds only when NO higher rung is present, which is
// exactly the situation the fallback exists for.
//
// So the same act is gated wherever it is authored. The submit path gates a run-time grading plan; this is
// what lets a dataset's own declaration be gated at ITS write boundary instead — once, on an immutable
// document, rather than on every schedule, CI trigger and product auto-eval that later runs it.
export function groundTruthDeclarations(cases: ReadonlyArray<Pick<EvalCase, "graders">>): string[] {
  const out = new Set<string>();
  for (const c of cases)
    for (const g of c.graders ?? []) {
      // The SAME reading composeVerdictPolicy uses: named metrics replace the id-based one.
      if (g.metrics !== undefined && g.metrics.length > 0) {
        for (const m of g.metrics) if (m.authority === "ground_truth") out.add(m.id);
        continue;
      }
      if (g.authority === "ground_truth") out.add(g.id);
    }
  return [...out].sort();
}

export interface GraderDeclarationConflict {
  metric: string;
  declared: string[];
}

export function effectiveGraderDeclarations(cases: ReadonlyArray<Pick<EvalCase, "graders">>): {
  graders: Array<Pick<GraderSpec, "id" | "authority" | "direction" | "metrics">>;
  conflicts: GraderDeclarationConflict[];
} {
  const graders: Array<Pick<GraderSpec, "id" | "authority" | "direction" | "metrics">> = [];
  const seen = new Set<string>();
  // metric → the distinct semantics declared for it, in the vocabulary a conflict message can print.
  const semantics = new Map<string, Set<string>>();
  for (const c of cases)
    for (const g of c.graders ?? []) {
      const key = contentDigest(g);
      if (!seen.has(key)) {
        seen.add(key);
        graders.push(g);
      }
      // The SAME reading composeVerdictPolicy uses: named metrics replace the id-based one.
      const declared =
        g.metrics !== undefined && g.metrics.length > 0
          ? g.metrics.map((m) => ({ metric: m.id, authority: m.authority, direction: m.direction }))
          : [{ metric: g.id, authority: g.authority, direction: g.direction }];
      for (const d of declared) {
        if (d.authority === undefined && d.direction === undefined) continue; // declares nothing
        const label = `${d.authority ?? "unspecified"}/${d.direction ?? "unspecified"}`;
        const set = semantics.get(d.metric) ?? new Set<string>();
        set.add(label);
        semantics.set(d.metric, set);
      }
    }
  const conflicts = [...semantics.entries()]
    .filter(([, labels]) => labels.size > 1)
    .map(([metric, labels]) => ({ metric, declared: [...labels].sort() }));
  return { graders, conflicts };
}

// The EFFECTIVE grading seal (identity axis inputs; arch-review 6, H5) — THE production builder, used by
// submit and by every test that claims to exercise production identity (a hand-written fixture here is how
// the selection-keyed composite bug hid). A runtime plan seals its own digest — selection-independent by
// construction (`graders` doubles as the plan marker the axis reads). Per-case defaults seal BOTH ways:
// `gradingCases` (caseId → digest of that case's defaults) is what the axis compares — shared cases only,
// so a deliberate subset is coverage, never a grading confound — and the selection-keyed `grading`
// composite is kept so equal composites still verify held against pre-gradingCases records.
export function sealGrading(
  plan: GraderSpec[] | undefined,
  selectedCases: ReadonlyArray<Pick<EvalCase, "id" | "graders">>,
): Pick<ScorecardManifest, "grading" | "graders" | "gradingCases"> {
  if (plan && plan.length > 0) return { grading: contentDigest(plan), graders: contentDigest(plan) };
  return {
    grading: contentDigest(Object.fromEntries(selectedCases.map((c) => [c.id, c.graders]))),
    gradingCases: Object.fromEntries(selectedCases.map((c) => [c.id, contentDigest(c.graders)])),
  };
}

// ── EVERY SELECTED JUDGE LEAVES A ROW (review 39 P0-3) ───────────────────────────────────────────────
//
// A child went terminal when the judge PROMISE was done, which is not the same claim as "the judges
// answered". The Temporal driver swallowed a top-level judge failure outright (`.catch(() => {})`) and the
// in-process one settled regardless of what the judge stream had made of its tasks — so an unexpected judge
// infrastructure error could leave a case whose evidence is terminal and whose selected judge is simply not
// mentioned. Absent reads as "no judge was selected", which is a different fact and a strictly nicer one.
//
// The invariant at the commit point is about SHAPE, so it is satisfied by stating the absence rather than by
// blocking the batch: a judge that did not answer gets an explicit unmeasured row, retryable, so a re-score
// can pick it up and every aggregate keeps counting it out. Pure and total — a caller that already has full
// coverage gets its own array back.
export function completeJudgeCoverage(
  scores: readonly Score[],
  judges: ReadonlyArray<{ id: string }>,
  detail = "the judge did not report a verdict for this case",
): Score[] {
  const missing = judges.filter((j) => !scores.some((s) => isJudgeMetricOf(s.metric, j.id)));
  if (missing.length === 0) return [...scores];
  return [
    ...scores,
    ...missing.map(
      (j): Score => ({
        graderId: j.id,
        metric: `judge:${j.id}`,
        status: "unmeasured",
        // Not `unsupported`: nothing about the configuration says this judge cannot run — it was selected,
        // it was asked, and no answer arrived. That is an error, and a re-score is exactly the recovery.
        reason: "grader_error",
        retryable: true,
        detail,
      }),
    ),
  ];
}
