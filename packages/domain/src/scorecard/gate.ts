import {
  type CaseMatcher,
  type GateAudit,
  type GateDecision,
  type GatePolicy,
  type GateReason,
  type GateScoringPin,
  type ScorecardRecord,
  type VerdictPolicyRef,
  caseMatches,
} from "@everdict/contracts";
import { contentDigest } from "../provenance/content-digest.js";
import type { ExperimentIdentity } from "./experiment-identity.js";
import type { MeasurementCoverage, ScorecardDiff } from "./scorecard.js";
import { decisionInputTrustOf } from "./scoring-revision.js";
import type { TrialDiff } from "./trials.js";

// Release-gate evaluation (metrics commercialization A1) — ONE pure derivation from the diff the trust
// kernel already computes. The gate's competitive claim is the middle decisions: `not_comparable` and
// `blocked_missing` are first-class, so an incomparable OR an incomplete pair can never produce a false
// green light, and "no differences" is a different answer from "the comparison does not hold" — which is
// again different from "the comparison held, but not over enough".
export type GateInput = ScorecardDiff & {
  trials?: TrialDiff;
  policyMismatch?: { baseline: VerdictPolicyRef; candidate: VerdictPolicyRef };
  // A side whose STAMPED policy could not be restored — its verdicts are not re-derivable, so the pair is
  // not comparable. Carries the unrestorable stamp(s) so the refusal names what is missing.
  policyUnresolvable?: { baseline?: VerdictPolicyRef; candidate?: VerdictPolicyRef };
  // The manifest-vs-manifest identity read (experimentIdentity): which held-constant axes verifiably differ
  // (confounds — a different experiment, refused unless acknowledged) and which could not be verified either
  // way. Optional: a caller without manifests simply cannot gate on identity — the gate invents nothing.
  experiment?: ExperimentIdentity;
  // Evidence quality of each side (measurementCoverage). Optional: a caller that cannot supply it simply
  // cannot gate on maxUnmeasuredFraction — the gate never invents a coverage number it was not given.
  coverage?: { baseline: MeasurementCoverage; candidate: MeasurementCoverage };
  // Cases the CANDIDATE's stamped verdict policy declared critical (VerdictPolicy.criticalCases). Read off
  // the candidate because it is the candidate that is asking to ship: criticality is a claim about what this
  // release must not break. Absent ⇒ nothing was declared critical, and the gate is pure arithmetic.
  criticalCases?: readonly CaseMatcher[];
};

export type GateEvaluation = Pick<GateDecision, "decision" | "reasons" | "evidence">;

// Fail-closed default. A gate exists to withhold a green light the evidence does not support, so the
// caller that wants to decide on a PARTIAL comparison is the one who has to say so.
const DEFAULT_COMPARABILITY: NonNullable<GatePolicy["comparability"]> = "require_full";

// ── RECORDED DOUBT IS ENFORCED DOUBT (arch-review 47 P0-3) ───────────────────────────────────────────
//
// The pins carry each side's input observation; this is where a decision CONSUMES it. A completed
// divergence makes the comparison `not_comparable` on either side — the verdicts describe executions that
// have since been replaced, and no policy waives a known-wrong subject. An UNVERIFIED input (ingest with no
// receipts, a ledger outage at judging time) refuses by default and passes only under the recorded
// allowUnverifiedInput acknowledgement. A legacy pin (pre-observation revision) rides as information on the
// pin itself — history is not retroactively re-judged.
export function applyInputTrust(
  evaluation: GateEvaluation,
  pins: { baseline?: GateScoringPin; candidate?: GateScoringPin },
  policy: GatePolicy,
): GateEvaluation {
  const reasons: GateReason[] = [];
  for (const [side, pin] of [
    ["baseline", pins.baseline],
    ["candidate", pins.candidate],
  ] as const) {
    const trust = decisionInputTrustOf(pin);
    if (trust === "diverged")
      reasons.push({
        kind: "input_diverged",
        detail: `the ${side}'s pinned judgment read ${pin?.inputObservation?.diverged ?? 0} case(s) whose execution the receipt ledger no longer vouches for — its verdicts describe bytes that have since been replaced`,
        count: pin?.inputObservation?.diverged ?? 0,
      });
    else if (trust !== "receipt_vouched" && policy.allowUnverifiedInput !== true)
      // `unavailable` AND `legacy_unverified` alike (owner decision, arch-review 47 follow-up): the default
      // is the review's — receipt-vouched input only. A pre-observation revision is not retro-vouched by its
      // age; a caller that wants to gate over history says so with the same recorded waiver.
      reasons.push({
        kind: "input_unverified",
        detail:
          trust === "legacy_unverified"
            ? `the ${side}'s pinned judgment predates input observation — nothing states what its judges read; refused unless the policy records allowUnverifiedInput`
            : `the ${side}'s pinned judgment states no receipt vouches for what its judges read — refused unless the policy records allowUnverifiedInput`,
      });
  }
  if (reasons.length === 0) return evaluation;
  return { ...evaluation, decision: "not_comparable", reasons: [...reasons, ...evaluation.reasons] };
}

export function evaluateGate(diff: GateInput, policy: GatePolicy): GateEvaluation {
  const reasons: GateReason[] = [];
  // When trials rode along, the Fisher-gated trial diff is the authoritative regression signal — raw
  // last-trial pass transitions are noise on a trial run (the diffTrials contract).
  const trialsGated = diff.trials !== undefined;
  // Cases the CANDIDATE never ran, against the baseline's own case count: "how much of what we compared
  // against did this candidate actually cover?". A candidate that ADDED cases lost no coverage, so extra
  // candidate-only cases are counted in missingCases but never inflate this fraction.
  const uncovered = diff.missing.casesOnlyInBaseline.length;
  const missingFraction = diff.overlap.baselineCases > 0 ? uncovered / diff.overlap.baselineCases : undefined;
  // The WORSE of the two sides: a comparison is only as measured as its weaker half — a baseline made of
  // placeholders makes "no regression" meaningless just as surely as a hollow candidate does.
  const unmeasuredFraction = worstUnmeasuredFraction(diff.coverage);
  // The STRUCTURAL half of the evidence — what was and wasn't compared. Computable regardless of whether the
  // verdicts themselves can be trusted, which is why the refusal paths below may carry it.
  const structural = {
    comparability: diff.comparability,
    missingCases: diff.missing.casesOnlyInBaseline.length + diff.missing.casesOnlyInCandidate.length,
    trialsGated,
    ...(missingFraction !== undefined ? { missingFraction } : {}),
    ...(unmeasuredFraction !== undefined ? { unmeasuredFraction } : {}),
  };

  // ── The refusals come FIRST, before any verdict-derived number exists ──
  // Unknown policy means unknown verdict: a not_comparable decision must not carry regression counts — the
  // pre-fix order computed them first and the refusal then SPREAD them into persisted gate evidence and the
  // decided-fact message ("regressions: 3, decision: not_comparable"), numbers nobody had the right to derive.
  // An unrestorable stamp refuses BEFORE the comparability check rather than inside it: the caller forces
  // `none` on this too, but a gate that only refuses when someone else remembered to mark the diff is a gate
  // one forgotten line away from a false green light.
  if (diff.policyUnresolvable !== undefined) {
    const sides = [
      ...(diff.policyUnresolvable.baseline ? [`baseline (${stampLabel(diff.policyUnresolvable.baseline)})`] : []),
      ...(diff.policyUnresolvable.candidate ? [`candidate (${stampLabel(diff.policyUnresolvable.candidate)})`] : []),
    ];
    reasons.push({
      kind: "policy_unresolvable",
      detail: `the stamped verdict policy of the ${sides.join(" and ")} could not be restored — those verdicts cannot be re-derived, and re-judging them under today's ladder would decide this release on numbers the batch never produced`,
    });
    return { decision: "not_comparable", reasons, evidence: { ...structural, comparability: "none" } };
  }

  // A VERIFIED confound on an unacknowledged axis is a different experiment, not a treatment comparison:
  // the numbers below would measure the drift of the apparatus (dataset content, grading plan, judge
  // documents), so none of them are computed. Acknowledged confounds and unverifiable axes ride as recorded
  // reasons on whatever the gate goes on to decide — accepted is not the same claim as identical.
  const allowedConfounds = new Set(policy.allowConfounds ?? []);
  const confounds = diff.experiment?.confounds ?? [];
  const refusedConfounds = confounds.filter((c) => !allowedConfounds.has(c.axis));
  if (refusedConfounds.length > 0) {
    for (const c of refusedConfounds)
      reasons.push({
        kind: "confounded",
        detail: `${c.detail} — a held-constant axis of the experiment differs, so this is a different experiment; acknowledge the axis via allowConfounds to compare anyway`,
      });
    return { decision: "not_comparable", reasons, evidence: { ...structural, comparability: "none" } };
  }
  // UNVERIFIABLE identity refuses the GATE too — by default. Analytics may honestly show "unknown" beside
  // the numbers, but a release gate issuing green on an identity nobody can verify is a guarantee standing
  // on nothing: the trust kernel already refuses to derive verdicts from an unknown policy and refuses to
  // treat an unknown egress as safe, and identity was the one unknown still waved through. The gap is
  // acknowledgeable (allowUnverifiedIdentity, recorded on the decision like a force), and the informational
  // reasons still ride whatever gets decided.
  const unverifiedIdentity = diff.experiment?.unverified ?? [];
  if (unverifiedIdentity.length > 0 && policy.allowUnverifiedIdentity !== true) {
    for (const u of unverifiedIdentity)
      reasons.push({
        kind: "identity_unverified",
        detail: `${u.detail} — a green light cannot stand on an unverifiable identity; acknowledge via allowUnverifiedIdentity to decide anyway`,
      });
    return { decision: "not_comparable", reasons, evidence: { ...structural, comparability: "none" } };
  }

  if (diff.comparability === "none") {
    if (diff.policyMismatch !== undefined) {
      reasons.push({
        kind: "policy_mismatch",
        detail: `the two batches were judged under different verdict policies (${diff.policyMismatch.baseline.digest} vs ${diff.policyMismatch.candidate.digest}) — their verdicts were produced by different rules`,
      });
    } else {
      reasons.push({
        kind: "no_shared_cases",
        detail: "no shared cases or metrics — there is nothing this comparison can claim",
      });
    }
    return { decision: "not_comparable", reasons, evidence: structural };
  }

  // Past the refusals, the identity read still rides as RECORDED information on whatever gets decided:
  // an acknowledged confound is accepted, not identical, and an acknowledged identity gap is accepted, not
  // verified — the decision must say which claim it stands on.
  for (const c of confounds)
    reasons.push({ kind: "confounded", detail: `${c.detail} — accepted by policy.allowConfounds (recorded)` });
  for (const u of unverifiedIdentity)
    reasons.push({
      kind: "identity_unverified",
      detail: `${u.detail} — accepted by policy.allowUnverifiedIdentity (recorded)`,
    });

  // The regression unit is the CASE VERDICT — one case, one transition, judged by the authority ladder.
  // Metric-level pass flips (diff.regressions) are diagnosis: a diagnostic judge flip on a case whose
  // ground truth still passes is not a case that "flipped pass → fail", and one case losing three metrics
  // is one regression, not three. Same unit as the trials path, so trials=1 and trials>1 gate identically.
  const brokeCases = diff.caseTransitions.filter((t) => t.change === "broke");
  const fixedCases = diff.caseTransitions.filter((t) => t.change === "fixed");
  const regressions = trialsGated && diff.trials ? diff.trials.regressions.length : brokeCases.length;
  // Product judgment, computed before any statistics can weigh in on it.
  const critical = criticalReasons(diff);
  // Regressions the per-case test found and the BH correction then withdrew. Counted only when a correction
  // actually ran — absence says "no correction", which is not the same claim as "nothing was suppressed".
  const suppressedByFdr =
    trialsGated && diff.trials?.fdrAlpha !== undefined
      ? diff.trials.cases.filter((c) => c.fdrSuppressed === true).length
      : undefined;
  const evidence: GateEvaluation["evidence"] = {
    ...structural,
    regressions,
    improvements: trialsGated && diff.trials ? diff.trials.improvements.length : fixedCases.length,
    ...(diff.criticalCases !== undefined ? { criticalFailures: critical.length } : {}),
    ...(suppressedByFdr !== undefined ? { suppressedByFdr } : {}),
  };

  // ── Missingness, decided BEFORE the arithmetic ──
  // `partial` means the comparison held only over part of what was asked: cases the candidate never ran,
  // metrics that vanished, columns whose value kind changed. Reading "0 regressions" out of the 60 cases
  // that survived a 100-case baseline is evidence about 60 cases — the arithmetic below is honest and the
  // CONCLUSION drawn from it is not. So a partial comparison blocks by default, and a caller who wants to
  // ship on a subset says so (allow_partial) and states how much loss it accepts.
  const withheld = missingnessReasons(diff, policy, { uncovered, missingFraction, unmeasuredFraction });

  if (trialsGated && diff.trials) {
    for (const r of diff.trials.regressions) {
      reasons.push({
        kind: "trial_regression",
        caseId: r.caseId,
        detail: `pass rate dropped ${r.baselineRate.toFixed(2)} → ${r.candidateRate.toFixed(2)} (statistically gated)`,
      });
    }
  } else {
    for (const t of brokeCases) {
      const flipped = diff.regressions.filter((r) => r.caseId === t.caseId).map((r) => r.metric);
      reasons.push({
        kind: "regression",
        caseId: t.caseId,
        detail: `case verdict flipped pass → fail${flipped.length > 0 ? ` (metric(s): ${flipped.join(", ")})` : ""}`,
      });
    }
  }
  // Kind-changed metrics ride as informational reasons — the comparison holds elsewhere, but these columns
  // must not be read as deltas.
  for (const m of diff.incomparable) {
    reasons.push({
      kind: "kind_changed",
      metric: m.metric,
      detail: "metric changed value kind — its delta is unreadable",
    });
  }

  const blocking = reasons.filter((r) => r.kind === "regression" || r.kind === "trial_regression").length;
  // A critical case outranks both of the decisions below. It is a plain `block`, not `blocked_missing`, even
  // when the case is simply absent: the gate is not withholding for lack of evidence, it is refusing a
  // release that broke something the policy said must not break.
  if (critical.length > 0) return { decision: "block", reasons: [...critical, ...withheld, ...reasons], evidence };
  // Missingness next: when the comparison was too incomplete to decide on, saying `blocked_missing` names
  // WHY the gate withheld the light. Any regressions found in the overlap still ride in `reasons` — the
  // decision changes, the evidence never shrinks.
  if (withheld.length > 0) return { decision: "blocked_missing", reasons: [...withheld, ...reasons], evidence };
  return { decision: blocking > policy.maxRegressions ? "block" : "pass", reasons, evidence };
}

// The one place where PRODUCT JUDGMENT precedes statistics, and it does so only because someone declared it:
// a login case going baseline 3/3 → candidate 0/3 is Fisher p=0.1 — an honest "not significant" — and
// shipping a fully broken login on that arithmetic is still wrong. So a case the candidate's verdict policy
// named critical blocks when it collapses, regardless of significance, of maxRegressions, and of any
// missingness tolerance. Nothing here fires unless `criticalCases` was declared: statistics stay in charge
// everywhere else, by default.
function criticalReasons(diff: GateInput): GateReason[] {
  const matchers = diff.criticalCases;
  if (!matchers || matchers.length === 0) return [];
  const isCritical = (caseId: string): boolean => matchers.some((m) => caseMatches(m, caseId));
  const out: GateReason[] = [];
  // Absent from the candidate. A tolerance for ORDINARY missingness (allow_partial + maxMissing*) never
  // covers a critical case — "we accept losing some coverage" was never an acceptance of losing this one.
  for (const caseId of diff.missing.casesOnlyInBaseline) {
    if (!isCritical(caseId)) continue;
    out.push({
      kind: "critical_case_failed",
      caseId,
      detail: `critical case '${caseId}' is missing from the candidate — a missingness tolerance covers ordinary coverage loss, never a case the policy declared critical`,
    });
  }
  if (diff.trials) {
    // Collapsed to a zero pass rate while the baseline had passes. Statistical significance is deliberately
    // not consulted: at three trials the exact test cannot reach 95% no matter how total the collapse.
    for (const c of diff.trials.cases) {
      if (!isCritical(c.caseId) || c.candidateRate > 0 || c.baselineRate <= 0) continue;
      out.push({
        kind: "critical_case_failed",
        caseId: c.caseId,
        detail: `critical case '${c.caseId}' failed every one of its ${c.candidateTrials} candidate trial(s) after passing ${(c.baselineRate * 100).toFixed(0)}% of ${c.baselineTrials} on the baseline — blocked regardless of statistical significance (p=${c.p.toFixed(3)})`,
      });
    }
  } else {
    // Case-verdict transitions, not metric flips: a critical case is a case the policy says must not BREAK,
    // and "broke" is the authority ladder's claim about the case — a diagnostic metric dip on a case whose
    // verdict still passes is not a broken critical case.
    for (const t of diff.caseTransitions) {
      if (t.change !== "broke" || !isCritical(t.caseId)) continue;
      out.push({
        kind: "critical_case_failed",
        caseId: t.caseId,
        detail: `critical case '${t.caseId}' verdict flipped pass → fail — blocked regardless of the regression budget`,
      });
    }
  }
  return out;
}

// A stamp as a refusal names it — id@version plus the digest that was looked for and not found.
function stampLabel(ref: VerdictPolicyRef): string {
  return `${ref.id}@${ref.version} ${ref.digest}`;
}

function worstUnmeasuredFraction(coverage: GateInput["coverage"]): number | undefined {
  if (!coverage) return undefined;
  const sides = [coverage.baseline.unmeasuredFraction, coverage.candidate.unmeasuredFraction].filter(
    (f): f is number => f !== undefined,
  );
  return sides.length > 0 ? Math.max(...sides) : undefined;
}

// Per-metric coverage LOSS on the candidate side: the baseline measured the metric, and the candidate
// measured a smaller share of its rows — rows the grader silently never emitted (a reported-unmeasured row
// is measurementCoverage's axis; an unemitted row is this one's). COMPLETE disappearance (candidate 0 rows)
// is the MAXIMAL loss, 1.0, in the same algebra: the pre-fix both-sides filter routed it into
// metricsOnlyInBaseline — which allow_partial never reads — so `maxMetricLossFraction: 0` passed a metric
// that vanished entirely while blocking one that lost a single row.
function metricCoverageLosses(
  diff: GateInput,
): Array<{ metric: string; baselineFraction: number; candidateFraction: number; loss: number }> {
  const fractionOf = (measured: number, cases: number): number => (cases > 0 ? measured / cases : 0);
  return diff.metricCoverage
    .filter((m) => m.baselineMeasured > 0) // a candidate-only metric has nothing to lose
    .map((m) => {
      const baselineFraction = fractionOf(m.baselineMeasured, m.baselineCases);
      const candidateFraction = fractionOf(m.candidateMeasured, m.candidateCases);
      // Loss relative to what the baseline measured — 100/100 → 1/100 is a 0.99 loss.
      const loss = baselineFraction > 0 ? Math.max(0, 1 - candidateFraction / baselineFraction) : 0;
      return { metric: m.metric, baselineFraction, candidateFraction, loss };
    })
    .filter((m) => m.loss > 1e-9);
}

// The reasons a comparison is too incomplete to decide on. Empty ⇒ the gate may read the arithmetic.
function missingnessReasons(
  diff: GateInput,
  policy: GatePolicy,
  measured: { uncovered: number; missingFraction?: number; unmeasuredFraction?: number },
): GateReason[] {
  const out: GateReason[] = [];
  const mode = policy.comparability ?? DEFAULT_COMPARABILITY;
  const missingCases = diff.missing.casesOnlyInBaseline.length + diff.missing.casesOnlyInCandidate.length;
  // A metric that exists on one side only, or whose value kind changed, is a column the comparison lost —
  // both are causes of `partial`, so both are counted here.
  const missingMetrics =
    diff.missing.metricsOnlyInBaseline.length + diff.missing.metricsOnlyInCandidate.length + diff.incomparable.length;
  const coverageLosses = metricCoverageLosses(diff);

  if (diff.comparability === "partial" && mode === "require_full") {
    if (missingCases > 0)
      out.push({
        kind: "missing_cases",
        count: missingCases,
        ...(measured.missingFraction !== undefined ? { fraction: measured.missingFraction } : {}),
        detail: `${measured.uncovered} of the baseline's ${diff.overlap.baselineCases} case(s) were not run by the candidate — this comparison covers a subset, so it cannot answer whether the whole suite regressed (set comparability "allow_partial" to decide on a subset deliberately)`,
      });
    if (missingMetrics > 0)
      out.push({
        kind: "missing_metrics",
        count: missingMetrics,
        detail:
          "metric(s) exist on one side only or changed value kind — the comparison lost columns, so a clean result over what remains is not a clean result",
      });
    // Silent grader omission: the metric "exists on both sides" to a set comparison while most of its rows
    // were never emitted. 99 vanished measurements out of 100 must not read as a green light.
    if (coverageLosses.length > 0)
      out.push({
        kind: "missing_metrics",
        count: coverageLosses.length,
        detail: `metric(s) lost measurement coverage on the candidate side (${coverageLosses
          .map(
            (m) =>
              `${m.metric}: ${(m.baselineFraction * 100).toFixed(0)}% → ${(m.candidateFraction * 100).toFixed(0)}% of rows`,
          )
          .join(
            ", ",
          )}) — rows the grader silently never emitted are not evidence, and a clean result over the surviving rows is not a clean result`,
      });
  } else if (diff.comparability === "partial" && mode === "allow_partial") {
    // The caller accepted a subset — but only up to the limits it stated. An unstated limit is not a limit.
    const overCount = policy.maxMissingCases !== undefined && missingCases > policy.maxMissingCases;
    const overFraction =
      policy.maxMissingFraction !== undefined &&
      measured.missingFraction !== undefined &&
      measured.missingFraction > policy.maxMissingFraction;
    if (overCount || overFraction)
      out.push({
        kind: "missing_cases",
        count: missingCases,
        ...(measured.missingFraction !== undefined ? { fraction: measured.missingFraction } : {}),
        detail: overCount
          ? `${missingCases} one-sided case(s) exceeds the policy's maxMissingCases of ${policy.maxMissingCases}`
          : `${((measured.missingFraction ?? 0) * 100).toFixed(1)}% of the baseline's cases were not run by the candidate, over the policy's maxMissingFraction of ${policy.maxMissingFraction}`,
      });
    // allow_partial names THREE different losses now, each with its own stated limit: case coverage
    // (maxMissingCases/maxMissingFraction above), METRIC coverage (here), and measurement quality
    // (maxUnmeasuredFraction below). "partial" as one word used to cover all three with one case knob.
    const overMetricLoss =
      policy.maxMetricLossFraction !== undefined
        ? coverageLosses.filter((m) => m.loss > (policy.maxMetricLossFraction ?? 1))
        : [];
    if (overMetricLoss.length > 0)
      out.push({
        kind: "missing_metrics",
        count: overMetricLoss.length,
        detail: `metric(s) lost more measurement coverage than the policy's maxMetricLossFraction of ${policy.maxMetricLossFraction} allows (${overMetricLoss
          .map((m) => `${m.metric}: ${(m.loss * 100).toFixed(1)}% lost`)
          .join(", ")})`,
      });
    // A kind-changed column is NOT a tolerance question — same name, different meaning, its delta unreadable —
    // so allow_partial still refuses it unless the caller explicitly accepted the column loss. (The loss knobs
    // above bound HOW MUCH may be missing; this one is about a column that is present and means something else.)
    if (diff.incomparable.length > 0 && policy.allowMetricKindChange !== true)
      out.push({
        kind: "kind_changed",
        count: diff.incomparable.length,
        detail: `metric(s) changed value kind (${diff.incomparable
          .map((m) => m.metric)
          .join(
            ", ",
          )}) — same name, different meaning; set allowMetricKindChange to accept the column loss deliberately`,
      });
  }

  // Independent of the comparability mode: unmeasured scores never make a comparison `partial` (both sides
  // report the same metrics, they are just empty), so this limit would be unreachable if it were gated on it.
  if (
    policy.maxUnmeasuredFraction !== undefined &&
    measured.unmeasuredFraction !== undefined &&
    measured.unmeasuredFraction > policy.maxUnmeasuredFraction
  )
    out.push({
      kind: "unmeasured_evidence",
      fraction: measured.unmeasuredFraction,
      detail: `${(measured.unmeasuredFraction * 100).toFixed(1)}% of the compared scores were not measurements (dead graders / skipped judges), over the policy's maxUnmeasuredFraction of ${policy.maxUnmeasuredFraction} — the numbers that survived are real, there are just too few of them to ship on`,
    });
  return out;
}

export function gatePolicyDigest(policy: GatePolicy): string {
  return contentDigest(policy);
}

// B2 — the audit window over the ledger's recorded decisions: counts by decision, every override with its
// stated reason, and the override rate (ABSENT when no block landed in the window — absence, never 0).
export function gateAudit(
  records: Array<Pick<ScorecardRecord, "id" | "gates">>,
  window?: { from?: string; to?: string },
): GateAudit {
  const decisions = { total: 0, pass: 0, block: 0, blockedMissing: 0, notComparable: 0 };
  const entries: GateAudit["overrides"]["entries"] = [];
  for (const record of records) {
    for (const g of record.gates ?? []) {
      if (window?.from !== undefined && g.decidedAt < window.from) continue;
      if (window?.to !== undefined && g.decidedAt > window.to) continue;
      decisions.total++;
      if (g.decision === "pass") decisions.pass++;
      else if (g.decision === "block") decisions.block++;
      else if (g.decision === "blocked_missing") decisions.blockedMissing++;
      else decisions.notComparable++;
      if (g.override) {
        entries.push({
          candidate: g.candidate,
          gateId: g.id,
          baseline: g.baseline,
          by: g.override.by,
          reason: g.override.reason,
          at: g.override.at,
        });
      }
    }
  }
  return {
    ...(window?.from !== undefined ? { from: window.from } : {}),
    ...(window?.to !== undefined ? { to: window.to } : {}),
    decisions,
    overrides: { count: entries.length, entries },
    // Denominator = every decision that COULD be overridden (both blocking kinds), so a team routinely
    // forcing incomplete comparisons through shows up here instead of hiding behind a zero-block window.
    ...(decisions.block + decisions.blockedMissing > 0
      ? { overrideRate: entries.length / (decisions.block + decisions.blockedMissing) }
      : {}),
  };
}
