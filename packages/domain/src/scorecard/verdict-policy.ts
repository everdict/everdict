import {
  type CaseFailure,
  type CaseMatcher,
  type CaseResult,
  type GraderSpec,
  type MeasurementIdentity,
  type MetricAuthority,
  type MetricDefinition,
  type Score,
  type VerdictAggregation,
  type VerdictPolicy,
  type VerdictPolicyRef,
  isConstitutionalMetric,
  isMeasured,
  measuredScores,
  metricMatches,
  normalizeScore,
} from "@everdict/contracts";
import { contentDigest, digestHex, digestsMatch } from "../provenance/content-digest.js";

// Stages at/before which a failure means the case never produced a legitimate outcome (no product verdict).
// A collect/grade-stage failure is different BY DESIGN: the run completed and compute-bound measurements
// still stand — partial results are preserved, the failure only marks the missing evidence plane.
export const PRE_OUTCOME_STAGES: ReadonlySet<CaseFailure["stage"]> = new Set(["dispatch", "install", "run"]);

// The verdict-policy engine — evaluates a case against a DECLARED policy and returns a verdict that can
// explain itself: which rung decided, under which aggregation, from which measurements. The default policy
// below encodes the historical authority ladder exactly (golden-pinned by caseVerdict's tests), so switching
// the string-array implementation to this engine changes no verdict. trust-kernel contract ③.

export interface VerdictBasis {
  authority: MetricAuthority | "fallback";
  aggregation: VerdictAggregation;
  // The measurements that decided (metric + grader + their individual pass) — the audit trail of the verdict.
  deciders: Array<{
    metric: string;
    graderId: string;
    pass: boolean;
    measurement?: MeasurementIdentity;
    measurementRefs?: Array<{ index: number; digest: string }>;
  }>;
  policyDigest?: string;
}

export interface VerdictEvaluation {
  verdict?: boolean; // absent = nothing decided (unmeasured case, infra_failed, or invalidated below)
  basis?: VerdictBasis; // present exactly when verdict is
  // Set when a REQUIRED metric had no measurement and its missingPolicy invalidates the case — the absence
  // of a verdict then has a stated cause, not just an empty object.
  invalidated?: { reason: "required_metric_missing"; metric: string };
}

// The 1.0.0 document EXACTLY as it stamped batches — frozen verbatim so those stamps keep resolving
// (KNOWN_VERDICT_POLICIES is append-only; an edited document cannot restore the history its stamp names).
// Its gap: no matcher covered `judge:<id>:<criterion>` (3+ segments), so with the top-level judge metric
// absent, criterion sub-scores fell into the undeclared fallback and could decide a case the policy calls
// them diagnostic localization of. 1.1.0 below closes that.
export const DEFAULT_VERDICT_POLICY_V1: VerdictPolicy = {
  id: "authority-ladder",
  version: "1.0.0",
  metrics: [
    { match: { metric: "state" }, authority: "ground_truth" },
    { match: { metric: "tests_pass" }, authority: "ground_truth" },
    { match: { metric: "answer_match" }, authority: "objective" },
    { match: { metric: "url_matches" }, authority: "objective" },
    { match: { metric: "dom_contains" }, authority: "objective" },
    { match: { metric: "judge" }, authority: "judge" },
    { match: { prefix: "judge:", segments: 2 }, authority: "judge" },
    { match: { metric: "cost_usd" }, authority: "observational", direction: "lower_is_better" },
    { match: { metric: "latency_ms" }, authority: "observational", direction: "lower_is_better" },
    { match: { metric: "tool_calls" }, authority: "observational", direction: "lower_is_better" },
  ],
  rungs: { ground_truth: "priority", objective: "all", judge: "all" },
  fallback: "all",
};

// The historical authority ladder as a policy document. version bumps REQUIRE review (constitution-gated
// once O1 lands): verdicts are derived on read, so an unstamped edit here would rewrite history — the
// ScorecardBatch stamps this policy's ref at settle precisely so old records resolve their own policy.
// A change is a NEW VERSION appended below, with the previous document frozen above.
export const DEFAULT_VERDICT_POLICY_V11: VerdictPolicy = {
  id: "authority-ladder",
  version: "1.1.0",
  metrics: [
    // ground truth — declaration order is the priority order ("priority" rung): state beats tests_pass.
    { match: { metric: "state" }, authority: "ground_truth" },
    { match: { metric: "tests_pass" }, authority: "ground_truth" },
    // objective deterministic comparisons — unanimous.
    { match: { metric: "answer_match" }, authority: "objective" },
    { match: { metric: "url_matches" }, authority: "objective" },
    { match: { metric: "dom_contains" }, authority: "objective" },
    // judge verdicts: legacy "judge" and the real top-level `judge:<id>` (2 segments). Deeper metrics
    // (`judge:<id>:<criterion>`, milestones) are diagnostic localization and never decide — the catch-all
    // prefix matcher AFTER the 2-segment one declares that (first match wins, so top-level judges still
    // decide; everything deeper is stripped before any rung or fallback can read it).
    { match: { metric: "judge" }, authority: "judge" },
    { match: { prefix: "judge:", segments: 2 }, authority: "judge" },
    { match: { prefix: "judge:" }, authority: "judge", verdictRole: "diagnostic" },
    // observational trace metrics — directions declared for diff/comparability, never pass-deciding.
    { match: { metric: "cost_usd" }, authority: "observational", direction: "lower_is_better" },
    { match: { metric: "latency_ms" }, authority: "observational", direction: "lower_is_better" },
    { match: { metric: "tool_calls" }, authority: "observational", direction: "lower_is_better" },
  ],
  rungs: { ground_truth: "priority", objective: "all", judge: "all" },
  fallback: "all",
};

// New records use structured coordinates. The old documents stay byte-for-byte fixed.
export const DEFAULT_VERDICT_POLICY: VerdictPolicy = {
  ...DEFAULT_VERDICT_POLICY_V11,
  version: "2.0.0",
  measurementIdentity: "structured-v1",
  metrics: [
    { match: { metric: "judge" }, criterion: "overall", authority: "judge" },
    { match: { metric: "judge" }, criterion: "any", authority: "judge", verdictRole: "diagnostic" },
    // These retain the legacy reading for score rows without structured coordinates.
    ...DEFAULT_VERDICT_POLICY_V11.metrics,
  ],
};

// Append-only registry of every policy that has ever stamped a scorecard — resolving a stamp MUST find the
// exact document, or the historical verdict cannot be re-derived. A new policy version is ADDED, never edited.
const KNOWN_VERDICT_POLICIES: readonly VerdictPolicy[] = [
  DEFAULT_VERDICT_POLICY,
  DEFAULT_VERDICT_POLICY_V11,
  DEFAULT_VERDICT_POLICY_V1,
];

// A stamp as a record carries it: id+version always, digest on everything written since the stamp existed.
export type StampedPolicyRef = Pick<VerdictPolicyRef, "id" | "version"> & Partial<Pick<VerdictPolicyRef, "digest">>;

// Resolving a stamp has THREE answers, and collapsing them to one policy is how a verdict gets rewritten
// behind everyone's back:
//   resolved       — the exact document that produced the historical verdicts is in hand.
//   legacy_default — no stamp at all (pre-mig-0125 rows); those batches really were judged under the ladder
//                    DEFAULT_VERDICT_POLICY encodes, so the default here restores history rather than replacing it.
//   unresolvable   — a stamp IS present and its document cannot be produced. This is the case that must never
//                    fall back: a composed policy lives only in its manifest, so an absent/mismatched manifest
//                    means re-judging under today's ladder — a silent retroactive rewrite of what "passing"
//                    meant. Readers surface the absence instead (no verdict, no gate decision).
export type PolicyResolution =
  | { status: "resolved"; policy: VerdictPolicy }
  | { status: "legacy_default"; policy: VerdictPolicy }
  | { status: "unresolvable"; ref: StampedPolicyRef };

// `embedded` = the full policy document a record carries in its manifest (a COMPOSED policy lives nowhere
// else). It is trusted only when its digest matches the stamped ref — a manifest edited after the fact does
// not get to rewrite the verdict; a digest mismatch is UNRESOLVABLE, not a licence to use the default.
// The registry hit is digest-checked too: KNOWN_VERDICT_POLICIES is append-only by contract, so an id+version
// whose document no longer hashes to the stamp is a document that was edited — it cannot restore that history.
// This is also the LIST-PATH guard: list reads carry the stamp but not the manifest, and a composed stamp
// (id "composed", never in the registry) with no embedded document lands here as unresolvable by construction.
export function resolvePolicyResolution(ref?: StampedPolicyRef, embedded?: VerdictPolicy): PolicyResolution {
  // No stamp = pre-mig-0125, which also means pre-1.1.0: those batches were judged under the FROZEN v1
  // ladder, so v1 is what restores their history — the live default would re-judge them under newer rules.
  if (!ref) return { status: "legacy_default", policy: DEFAULT_VERDICT_POLICY_V1 };
  // digestsMatch reads the algorithm off the STAMP: a record sealed under the FNV era verifies against its
  // own document, a record sealed since verifies under sha256. Comparing against one algorithm would make
  // every stamp of the other era unresolvable — which for this fail-closed resolver means erasing history.
  if (embedded && (ref.digest === undefined || digestsMatch(ref.digest, embedded)))
    return { status: "resolved", policy: embedded };
  const known = KNOWN_VERDICT_POLICIES.find((p) => p.id === ref.id && p.version === ref.version);
  if (known && (ref.digest === undefined || digestsMatch(ref.digest, known)))
    return { status: "resolved", policy: known };
  return { status: "unresolvable", ref };
}

// Compose the batch's verdict policy from the run-time grading plan's DECLARATIONS: a custom grader gains
// authority for the metric sharing its id by declaring it — no domain-code edit. Declared definitions are
// appended AFTER the built-ins, so a custom ground-truth ranks below state/tests_pass in the priority rung
// (adding a source of truth never silently outranks the established ones). No declarations ⇒ the base policy
// object itself (identity-comparable, so callers can tell "nothing composed").
// `criticalCases` composes in the same way and for the same reason: it is a per-batch product declaration
// ("this release must not break login") that a release gate acts on, so it belongs INSIDE the digested
// document rather than in the gate call — a recorded gate decision must be re-derivable without the flags
// whoever ran it happened to pass.
export function composeVerdictPolicy(
  specs: readonly Pick<GraderSpec, "id" | "authority" | "direction" | "metrics">[],
  base: VerdictPolicy = DEFAULT_VERDICT_POLICY,
  opts: { criticalCases?: readonly CaseMatcher[] } = {},
): VerdictPolicy {
  const additions: MetricDefinition[] = [];
  for (const spec of specs) {
    // A spec that NAMES its metrics is declaring semantics for those (arch-review 19 P1). The `id`-based
    // reading below is what a grader whose metric equals its type gets, and for everything else it composed a
    // rule about a name nothing emits — `id: "script"` declaring authority produced `match: {metric:"script"}`
    // while the score that landed was `quality`. Explicit metrics REPLACE that reading rather than adding to
    // it: naming them is saying the type is not one of them.
    if (spec.metrics !== undefined && spec.metrics.length > 0) {
      for (const m of spec.metrics) {
        if (m.authority === undefined) continue;
        // A CONSTITUTIONAL NAME IS NOT DECLARABLE (arch-review 20 P0-1), enforced here as well as at submit.
        // Submit refuses the request that writes one, which is where an author should learn; this is the
        // choke point every OTHER source flows through — a dataset registered before that refusal existed,
        // an inline bundle, a seed. The built-in ladder decides those names, and a composed document that
        // overrode them would rewrite the constitution from a data file.
        if (isConstitutionalMetric(m.id)) continue;
        additions.push({
          match: { metric: m.id },
          ...(base.measurementIdentity ? { producer: { kind: "grader" as const, id: spec.id } } : {}),
          authority: m.authority,
          ...(m.direction ? { direction: m.direction } : {}),
        });
      }
      continue;
    }
    if (spec.authority === undefined) continue;
    additions.push({
      match: { metric: spec.id },
      ...(base.measurementIdentity ? { producer: { kind: "grader" as const, id: spec.id } } : {}),
      authority: spec.authority,
      ...(spec.direction ? { direction: spec.direction } : {}),
    });
  }
  const criticalCases = opts.criticalCases ?? [];
  if (additions.length === 0 && criticalCases.length === 0) return base;
  const doc: VerdictPolicy = {
    ...base,
    id: "composed",
    version: "0",
    metrics: [...base.metrics, ...additions],
    ...(criticalCases.length > 0 ? { criticalCases: [...criticalCases] } : {}),
  };
  // The version IS the content identity — composed documents have no registry row to version against. The
  // hex payload without the algorithm prefix, so the version stays 12 characters of actual identity.
  return { ...doc, version: digestHex(verdictPolicyDigest(doc)).slice(0, 12) };
}

// Aggregate one rung's deciding measurements. "priority" needs the DEFINITION order — deciders arrive
// already ordered by their matching definition's declaration index.
function combine(aggregation: VerdictAggregation, deciders: Array<{ pass: boolean }>): boolean {
  switch (aggregation) {
    case "priority": {
      const first = deciders[0];
      if (first === undefined) throw new Error("combine called with no deciders"); // guarded by caller
      return first.pass;
    }
    case "all":
      return deciders.every((d) => d.pass);
    case "any":
      return deciders.some((d) => d.pass);
    case "majority":
      return deciders.filter((d) => d.pass).length > deciders.length / 2;
  }
}

// A duplicate metric (the same metric emitted twice in one case) previously hit a Map where the LAST score
// silently won. Duplicates now combine explicitly — unanimous within the metric name — before the rung sees
// one deciding value per metric. Attribution follows the DECISION: when the combination fails, the graderId
// is the first FAILING grader's (the verdict basis must name the grader whose measurement decided it, not
// whichever grader happened to emit first while another one failed the metric).
function dedupeByMetric(scores: Score[], structured: boolean): VerdictBasis["deciders"] {
  const grouped = new Map<string, VerdictBasis["deciders"][number]>();
  for (const [index, score] of scores.entries()) {
    if (!isMeasured(score) || score.pass === undefined) continue;
    const measurement = structured ? score.measurement : undefined;
    const key = measurement
      ? JSON.stringify([
          measurement.producer.kind,
          measurement.producer.id,
          measurement.metric,
          measurement.criterion ?? null,
        ])
      : score.metric;
    const refs = measurement ? [{ index, digest: contentDigest(normalizeScore(score)) }] : [];
    const previous = grouped.get(key);
    if (previous) {
      if (!score.pass && previous.pass) {
        previous.pass = false;
        previous.graderId = score.graderId;
      }
      previous.measurementRefs?.push(...refs);
    } else
      grouped.set(key, {
        metric: score.metric,
        graderId: score.graderId,
        pass: score.pass,
        ...(measurement ? { measurement, measurementRefs: refs } : {}),
      });
  }
  return [...grouped.values()];
}

function definitionMatches(
  def: MetricDefinition,
  score: { metric: string; measurement?: MeasurementIdentity },
  structured: boolean,
): boolean {
  if (!structured || !score.measurement)
    return def.producer === undefined && def.criterion === undefined && metricMatches(def.match, score.metric);
  const m = score.measurement;
  if (
    def.producer &&
    (def.producer.kind !== m.producer.kind || (def.producer.id !== undefined && def.producer.id !== m.producer.id))
  )
    return false;
  if (def.criterion === "overall" && m.criterion !== undefined) return false;
  if (def.criterion === "any" && m.criterion === undefined) return false;
  if (typeof def.criterion === "object" && def.criterion.id !== m.criterion) return false;
  return metricMatches(def.match, m.metric);
}

export function evaluateVerdict(
  result: Pick<CaseResult, "scores"> & Pick<Partial<CaseResult>, "failure">,
  policy: VerdictPolicy = DEFAULT_VERDICT_POLICY,
): VerdictEvaluation {
  // A case that never legitimately executed has no product verdict (caseOutcome's infra_failed) — and a
  // deliberately stopped case (CANCELLED) has none at ANY stage: partial work under a kill is not an outcome.
  if (result.failure && (result.failure.code === "CANCELLED" || PRE_OUTCOME_STAGES.has(result.failure.stage)))
    return {};
  // Only measurements decide — unmeasured/invalid placeholders never reach a rung.
  const measured = measuredScores(result.scores);
  const structured = policy.measurementIdentity === "structured-v1";

  // A REQUIRED metric with no measurement invalidates the case (its declared missingPolicy) — a verdict
  // standing on a hole it declared essential is not a verdict, and the absence states its cause.
  for (const d of policy.metrics) {
    if (d.verdictRole !== "required") continue;
    if ((d.missingPolicy ?? "invalidate_case") !== "invalidate_case") continue;
    if (!measured.some((s) => definitionMatches(d, s, structured))) {
      const metric = "metric" in d.match ? d.match.metric : `${d.match.prefix}*`;
      return { invalidated: { reason: "required_metric_missing", metric } };
    }
  }

  const candidates = dedupeByMetric(result.scores, structured).filter((c) => {
    // diagnostic/excluded metrics explain or observe — they never decide (stripped before any rung).
    const def = policy.metrics.find((d) => definitionMatches(d, c, structured));
    return def?.verdictRole !== "diagnostic" && def?.verdictRole !== "excluded";
  });

  // Index each pass-bearing metric to its first matching definition (declaration order = priority).
  const matched = new Map<(typeof candidates)[number], number>(); // metric → definition index
  for (const c of candidates) {
    const idx = policy.metrics.findIndex((d) => definitionMatches(d, c, structured));
    if (idx >= 0) matched.set(c, idx);
  }

  for (const authority of policy.authorityOrder ?? (["ground_truth", "objective", "judge"] as const)) {
    const deciders = candidates
      .filter((c) => {
        const idx = matched.get(c);
        return idx !== undefined && policy.metrics[idx]?.authority === authority;
      })
      .sort((a, b) => (matched.get(a) ?? 0) - (matched.get(b) ?? 0));
    if (deciders.length === 0) continue;
    const aggregation = policy.rungs[authority];
    // Priority selects a metric definition, not whichever producer returned first.
    // Distinct producers matching that definition still have to agree.
    if (structured && aggregation === "priority") {
      const first = deciders[0];
      const firstDefinition = first === undefined ? undefined : matched.get(first);
      const selected = deciders.filter((c) => matched.get(c) === firstDefinition);
      return {
        verdict: selected.every((c) => c.pass),
        basis: { authority, aggregation, deciders: selected, policyDigest: contentDigest(policy) },
      };
    }
    return {
      verdict: combine(aggregation, deciders),
      basis: { authority, aggregation, deciders, ...(structured ? { policyDigest: contentDigest(policy) } : {}) },
    };
  }

  if (policy.fallback === "none") return {};
  // Fallback: measured pass-bearing scores the policy has NEVER SEEN — undeclared metrics only.
  // Observational is verdict-INERT by definition ("measured but not pass-deciding"): a declared
  // observational metric that happens to carry a pass must not decide a case just because no rung did —
  // that would make the declaration weaker than saying nothing at all.
  const rest = candidates.filter((c) => matched.get(c) === undefined);
  if (rest.length === 0) return {};
  return {
    verdict: combine(policy.fallback, rest),
    basis: {
      authority: "fallback",
      aggregation: policy.fallback,
      deciders: rest,
      ...(structured ? { policyDigest: contentDigest(policy) } : {}),
    },
  };
}

// ── policy identity ──────────────────────────────────────────────────────────────────────────────────
export function verdictPolicyDigest(policy: VerdictPolicy): string {
  return contentDigest(policy);
}

// The SEMANTIC identity of a stamped policy, for cross-batch comparison (trend/leaderboard mixing, diff
// mismatch). Two stamps name the same rules iff their RESOLVED documents share one canonical digest — raw
// stamp strings split the identical document across digest eras (a legacy FNV stamp vs a sha256 stamp of
// the same canonical form read as "different policies", suppressing regressions across the migration
// boundary). An unstamped card is not its own rule-set either: it was judged under the frozen v1 ladder,
// so it compares equal to a card that stamped v1 explicitly. A stamp that resolves to no document in hand
// (a composed policy on a list read) keeps its raw digest as identity — two composed stamps then compare
// equal only within one era, which is the honest ceiling without the document.
export function verdictPolicyIdentity(ref?: StampedPolicyRef): string {
  if (!ref) return contentDigest(DEFAULT_VERDICT_POLICY_V1);
  const known = KNOWN_VERDICT_POLICIES.find((p) => p.id === ref.id && p.version === ref.version);
  if (known && (ref.digest === undefined || digestsMatch(ref.digest, known))) return contentDigest(known);
  return ref.digest ?? `${ref.id}@${ref.version}`;
}

export function verdictPolicyRef(policy: VerdictPolicy = DEFAULT_VERDICT_POLICY): VerdictPolicyRef {
  return { id: policy.id, version: policy.version, digest: verdictPolicyDigest(policy) };
}
