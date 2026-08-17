import { z } from "zod";

// Release-gate decision artifact (metrics commercialization A1/B1) — the CI-facing verdict over a
// baseline↔candidate comparison, RECORDED so governance can count what it never saw happen live: every
// decision, every block, every override with its reason (catalog R7). The gate stands on the trust kernel's
// comparability semantics: `not_comparable` is a FIRST-CLASS decision — "the comparison does not hold" is a
// different claim from "no differences", and a gate that answers pass on an incomparable pair is a false
// green light.
export const GatePolicySchema = z.object({
  // How many (statistically-gated, when trials rode along) regressions the gate tolerates. 0 = any regression
  // blocks. The effective policy is embedded in every decision — a decision must be re-derivable without the
  // caller's flags.
  maxRegressions: z.number().int().nonnegative(),
  // What an INCOMPLETE comparison means. "require_full" (the semantic default) refuses to decide on a
  // `partial` comparison at all: zero regressions among the 60 cases that survived out of 100 is evidence
  // about 60 cases, not evidence that nothing regressed. "allow_partial" lets a caller ship on a subset — but
  // only by SAYING so, and by stating its tolerance in the maxMissing* fields below.
  // The default is applied by the domain gate, NOT here: the policy embedded in a decision is exactly what
  // the caller sent, so an already-recorded `{maxRegressions: 0}` keeps its digest forever.
  comparability: z.enum(["require_full", "allow_partial"]).optional(),
  // Missingness tolerances — read only under "allow_partial" (under "require_full" any missingness blocks).
  // "partial" names THREE different losses, each with its own knob: CASE coverage (the two below), METRIC
  // coverage (maxMetricLossFraction — rows a grader silently never emitted), and measurement quality
  // (maxUnmeasuredFraction — rows that exist but are hollow). One word used to hide all three behind one knob.
  maxMissingCases: z.number().int().nonnegative().optional(), // one-sided cases (both directions) tolerated
  maxMissingFraction: z.number().min(0).max(1).optional(), // share of the BASELINE's cases the candidate may skip
  // Share of a metric's BASELINE measurement rate the candidate may lose before the gate blocks —
  // 100/100 → 1/100 is a 0.99 loss, complete disappearance (0/100) is 1.0 in the same algebra. Under
  // require_full ANY loss blocks.
  maxMetricLossFraction: z.number().min(0).max(1).optional(),
  // A metric whose VALUE KIND changed (categorical on one side, numeric on the other) is not a tolerance
  // question — same name, different meaning, its delta unreadable — so allow_partial still blocks on it
  // unless the caller accepts the column loss explicitly. require_full always blocks.
  allowMetricKindChange: z.boolean().optional(),
  // Experiment-identity axes the caller ACCEPTS as different (recorded on the decision like a force): a
  // verified confound on any axis NOT listed here refuses the comparison as not_comparable — a dataset whose
  // content changed, a grading plan that differs, a judge document that was edited are a different
  // experiment, not a treatment comparison.
  allowConfounds: z.array(z.enum(["dataset_content", "grading_plan", "judge_set", "harness_model"])).optional(),
  // UNVERIFIABLE identity (an unsealed side, a digest-era gap, a pre-split composite seal) also refuses the
  // GATE by default: analytics may honestly say "unknown", but a release gate issuing green on an identity
  // nobody can verify is a guarantee standing on nothing — the same reason an unresolvable policy refuses.
  // Setting this acknowledges the gap EXPLICITLY (recorded on the decision); the informational reasons still
  // ride whatever gets decided.
  allowUnverifiedIdentity: z.boolean().optional(),
  // The EXPLICIT waiver for input the ledger could not vouch (input_unverified — ingest scorecards, a ledger
  // outage at judging time). Recorded on the decision like every other acknowledgement; never covers a
  // COMPLETED divergence (arch-review 47 P0-3: recorded doubt must be enforced doubt, and an implicit pass
  // over unvouched input was exactly the gap).
  allowUnverifiedInput: z.boolean().optional(),
  // The EXPLICIT waiver for a pinned judgment with no recorded author (judgment_unrecorded — pre-Wave-D
  // revisions, a pass whose stage could not be read). Recorded on the decision like every other
  // acknowledgement; a caller gating over history says so rather than the gate assuming it.
  allowUnrecordedJudgments: z.boolean().optional(),
  // Share of the compared scores that may be non-measurements (dead graders / skipped judges). Enforced
  // INDEPENDENTLY of the comparability mode: unmeasured scores do not make a comparison `partial`, they
  // hollow it out from the inside, so a caller that sets this means it under either mode.
  maxUnmeasuredFraction: z.number().min(0).max(1).optional(),
  // Statistical policy for the trials diff this gate reads (absent ⇒ diffTrials' own defaults: 1.96 / 0).
  // Without these a CI caller could not set the significance bar it is gating on at all.
  zThreshold: z.number().positive().optional(),
  minDelta: z.number().min(0).max(1).optional(),
  // False-discovery-rate level for the Benjamini–Hochberg correction across the per-case trial tests of ONE
  // gate evaluation. Every case is its own hypothesis test: 200 cases at α≈0.05 produce ~10 false regressions
  // by construction, and under maxRegressions 0 any one of them blocks every release. Absent = no correction
  // (each case gated at its own alpha, exactly as before) — the correction is opt-in because it trades a
  // higher per-case miss rate for a controlled share of false blocks, and that is the caller's call.
  fdrAlpha: z.number().gt(0).lt(1).optional(),
});
export type GatePolicy = z.infer<typeof GatePolicySchema>;

export const GateReasonSchema = z.object({
  kind: z.enum([
    "regression",
    "trial_regression",
    "policy_mismatch",
    // One side's STAMPED verdict policy could not be restored, so its verdicts cannot be re-derived at all.
    // Deciding anyway would mean re-judging that batch under today's ladder — a green light standing on
    // numbers nobody produced.
    "policy_unresolvable",
    "no_shared_cases",
    "kind_changed",
    // A held-constant axis of the EXPERIMENT verifiably differs between the sides (dataset content, grading
    // plan, judge set): the delta measures the drift of the apparatus, not the treatment — a different
    // experiment, not a regression. Refuses unless the policy acknowledges the axis via allowConfounds.
    "confounded",
    // An identity axis could not be verified either way (an unsealed side, a digest-era gap, a pre-split
    // composite seal). On the GATE this refuses by default — a green light cannot stand on an identity
    // nobody can verify — unless the policy acknowledges the gap (allowUnverifiedIdentity, recorded); on an
    // acknowledged or non-gate read it rides as information.
    "identity_unverified",
    // A case the verdict policy declared CRITICAL either collapsed to a zero pass rate or is absent from the
    // candidate. This is the one place where product judgment precedes statistics: it blocks regardless of
    // significance, regardless of maxRegressions, and regardless of any missingness tolerance.
    "critical_case_failed",
    // The comparison itself was incomplete — cases the candidate never ran, metrics that vanished or changed
    // kind, scores that were never measurements. Each carries its counts so CI/UI can state WHY it blocked.
    "missing_cases",
    "missing_metrics",
    "unmeasured_evidence",
    // The pinned judgment's INPUT is not evidence the ledger stands behind (arch-review 47 P0-3):
    // `input_diverged` — the observation COMPLETED and reported divergence: the verdicts describe executions
    // that have since been replaced. Never waivable — a known-wrong subject is not a policy choice.
    // `input_unverified` — the observation could not vouch at all (an ingest with no receipts, a ledger
    // outage): refused by default, waivable only by the recorded allowUnverifiedInput policy. A revision
    // that PREDATES input observation entirely rides as legacy and is visible on the pin, not a reason.
    "input_diverged",
    "input_unverified",
    // The pinned judgment's AUTHOR is not recorded (arch-review 53, Wave D). The execution input may be
    // fully receipt-vouched and the score plane digested, and still nothing says WHICH invocation of which
    // judge produced the verdicts — which matters because the durable batch lane retries a case activity up
    // to ten times, so two invocations of one (case, judge) is ordinary. Refused by default and waivable
    // only by the recorded allowUnrecordedJudgments policy, exactly like `input_unverified`.
    "judgment_unrecorded",
  ]),
  detail: z.string(),
  caseId: z.string().optional(),
  metric: z.string().optional(),
  count: z.number().int().nonnegative().optional(), // how many (cases/metrics/scores) this reason counted
  fraction: z.number().optional(), // the ratio the reason was judged against, when it has one
});
export type GateReason = z.infer<typeof GateReasonSchema>;

export const GateOverrideSchema = z.object({
  by: z.string(),
  reason: z.string().min(1), // a forced ship without a stated reason is not an override, it is an accident
  at: z.string(),
});
export type GateOverride = z.infer<typeof GateOverrideSchema>;

// The scoring revision the gate READ on one side of the comparison: a score plane legally mutates later
// (re-score), so the decision pins {revision, scorePlaneDigest} — a reader that finds the record's current
// digest diverged from the pin knows this decision judged a plane that no longer exists, instead of silently
// attributing today's judgments to yesterday's verdict. Absent on sides that predate the scoring ledger
// (nothing to pin — honest absence, never a placeholder).
export const GateScoringPinSchema = z.object({
  revision: z.number().int().positive(),
  scorePlaneDigest: z.string(),
  // …AND WHAT THAT JUDGMENT READ (arch-review 46). The plane digest pins the verdicts; this pins the
  // observations they were derived from, projected off the revision's own `inputObservation`. Two decisions
  // whose plane digests agree can still have judged different executions (a case re-driven under the same
  // scoring pass), and `diverged > 0` says the revision itself already knows its verdicts describe bytes the
  // receipt ledger no longer vouches for. Absent = a revision from before this existed; `completed: false` =
  // the check could not run — neither is agreement, and readers that gate say so out loud.
  inputObservation: z
    .object({
      setDigest: z.string().optional(),
      completed: z.boolean(),
      diverged: z.number().int().nonnegative().optional(),
    })
    .optional(),
  // …AND WHICH INVOCATIONS AUTHORED IT (arch-review 52 wave 5). The plane digest pins the verdicts and the
  // observation pins their inputs; this pins their PROVENANCE — the digest of the revision's judgment-receipt
  // vector, each receipt naming the (pass, case, judge, claim) whose evidence was adopted. A decision that
  // is later disputed can then say which invocation of a flapping judge it shipped on, which no other field
  // here can: two invocations that agree leave identical plane digests. Absent = the revision carries no
  // vector (predates it, or ran with no scoring stage to arbitrate) — unrecorded, never "no judgments".
  judgmentReceiptSetDigest: z.string().optional(),
  // The pinned side's judgment provenance (arch-review 53, Wave D) — projected from the revision so a gate
  // can refuse a comparison whose judgment AUTHOR is unknown, exactly as it already refuses one whose
  // execution INPUT is unvouched.
  // Carries the COVERAGE the revision states (arch-review 54, Phase 3), not just the kind: a pin that
  // projected only `recorded` would let the gate accept a vector covering nothing, which is the defect that
  // made the field's first version decorative.
  judgmentProvenance: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("recorded"),
        digest: z.string(),
        expectedUnits: z.number().int().nonnegative(),
        recordedUnits: z.number().int().nonnegative(),
        complete: z.boolean(),
      }),
      z.object({ kind: z.literal("unrecorded"), reason: z.string() }),
    ])
    .optional(),
});
export type GateScoringPin = z.infer<typeof GateScoringPinSchema>;

export const GateDecisionSchema = z.object({
  id: z.string(),
  baseline: z.string(), // scorecard id
  candidate: z.string(), // scorecard id (the record this decision is appended to)
  baselineScoring: GateScoringPinSchema.optional(),
  candidateScoring: GateScoringPinSchema.optional(),
  // `blocked_missing` = the comparison held, but not over enough: the gate refuses to read a verdict out of
  // an incomplete comparison rather than issue a green light the evidence does not support. It blocks like
  // `block` and is overridable like `block` (a team may knowingly ship on a subset — with a stated reason).
  decision: z.enum(["pass", "block", "blocked_missing", "not_comparable"]),
  reasons: z.array(GateReasonSchema),
  policy: GatePolicySchema, // embedded in full — re-derivable without the caller
  policyDigest: z.string(),
  // The comparison evidence the decision stands on (counts, never the full diff — that is re-derivable).
  evidence: z.object({
    comparability: z.enum(["full", "partial", "none"]),
    // ABSENT when the gate refused to compare (unresolvable policy stamp / comparability none): a regression
    // count exists only where verdicts do — "0 regressions" on a not_comparable decision is a claim the gate
    // has no right to make, and the pre-fix shape persisted exactly that.
    regressions: z.number().int().nonnegative().optional(),
    improvements: z.number().int().nonnegative().optional(),
    missingCases: z.number().int().nonnegative(),
    trialsGated: z.boolean(), // true = the regression count is the Fisher-gated trials diff, not raw transitions
    // The share of the BASELINE's cases the candidate never ran — ABSENT when the baseline had no cases
    // (a ratio over nothing is absence, never 0).
    missingFraction: z.number().optional(),
    // The worse side's share of scores that were not measurements — ABSENT when coverage was not supplied.
    unmeasuredFraction: z.number().optional(),
    // Critical cases that failed or went missing — ABSENT when the candidate's policy declared none (absence
    // = "no criticality was declared", which is a different statement from "none of them failed").
    criticalFailures: z.number().int().nonnegative().optional(),
    // Per-case regressions that cleared their own alpha but did NOT survive the BH correction — ABSENT when
    // no fdrAlpha was in effect, 0 when the correction ran and suppressed nothing.
    suppressedByFdr: z.number().int().nonnegative().optional(),
  }),
  decidedBy: z.string().optional(),
  decidedAt: z.string(),
  // B1 — the recorded force: a block that shipped anyway, with who and why (audit reads these).
  override: GateOverrideSchema.optional(),
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;

// B2 — the governance window: every decision counted, every override enumerated with its stated reason.
export const GateAuditOverrideEntrySchema = z.object({
  candidate: z.string(),
  gateId: z.string(),
  baseline: z.string(),
  by: z.string(),
  reason: z.string(),
  at: z.string(),
});
export const GateAuditSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  decisions: z.object({
    total: z.number().int().nonnegative(),
    pass: z.number().int().nonnegative(),
    block: z.number().int().nonnegative(),
    blockedMissing: z.number().int().nonnegative(), // counted apart from `block`: refused for lack of evidence, not for a regression
    notComparable: z.number().int().nonnegative(),
  }),
  overrides: z.object({
    count: z.number().int().nonnegative(),
    entries: z.array(GateAuditOverrideEntrySchema),
  }),
  // overrides / overridable blocks (block + blockedMissing) — ABSENT when no block was recorded in the
  // window (a denominator of zero is absence).
  overrideRate: z.number().optional(),
});
export type GateAudit = z.infer<typeof GateAuditSchema>;

// B3 — manifest verification, facet by facet against the CURRENT registry state, under the STAMP's own
// algorithm. `drifted` answers "is the registry document still exactly what this batch evaluated?" (for the
// judge-closure facets: "would re-resolving today judge identically?") — collision-resistant evidence for a
// `sha256:` stamp, identity against honest data only for a pre-sha256 FNV one (bare 16 hex, still verified
// so history keeps verifying). `unverifiable` is confined to what genuinely is not replayable: the
// selection-keyed composites on subset/plan runs and "unresolved" closure seals — the split facets (`cases`,
// `grading`, the judge closure) verify regardless of selection. The caveat rides every response and says
// which of the two stamp eras this record's were, so no one mistakes the claim.
export const ManifestCheckSchema = z.object({
  // "dataset" (composite) | "cases" (per-case content seals, aggregated) | "grading" (effective grading) |
  // "harness" | "harness:model[:<service>]" (the harness model closure re-resolution) | "judge:<id>" (spec
  // document) | "judge:<id>:model|rubric|harness" (closure re-resolution) | "judge_run" | "verdict_policy"
  subject: z.string(),
  stored: z.string(),
  current: z.string().optional(),
  status: z.enum(["match", "drifted", "missing", "unverifiable"]),
  note: z.string().optional(),
});
export const ManifestVerificationSchema = z.object({
  id: z.string(),
  checks: z.array(ManifestCheckSchema),
  caveat: z.string(),
});
export type ManifestCheck = z.infer<typeof ManifestCheckSchema>;
export type ManifestVerification = z.infer<typeof ManifestVerificationSchema>;
