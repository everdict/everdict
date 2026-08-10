import {
  type CaseFailure,
  type CaseMatcher,
  type CaseResult,
  type GraderSpec,
  type MeasuredScore,
  type MetricAuthority,
  type MetricDefinition,
  type VerdictAggregation,
  type VerdictPolicy,
  type VerdictPolicyRef,
  measuredScores,
  metricMatches,
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
  deciders: Array<{ metric: string; graderId: string; pass: boolean }>;
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
export const DEFAULT_VERDICT_POLICY: VerdictPolicy = {
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

// Append-only registry of every policy that has ever stamped a scorecard — resolving a stamp MUST find the
// exact document, or the historical verdict cannot be re-derived. A new policy version is ADDED, never edited.
const KNOWN_VERDICT_POLICIES: readonly VerdictPolicy[] = [DEFAULT_VERDICT_POLICY, DEFAULT_VERDICT_POLICY_V1];

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
        additions.push({
          match: { metric: m.id },
          authority: m.authority,
          ...(m.direction ? { direction: m.direction } : {}),
        });
      }
      continue;
    }
    if (spec.authority === undefined) continue;
    additions.push({
      match: { metric: spec.id },
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
function dedupeByMetric(scores: MeasuredScore[]): Array<{ metric: string; graderId: string; pass: boolean }> {
  const byMetric = new Map<string, { metric: string; graderId: string; failedBy?: string; passes: boolean[] }>();
  for (const s of scores) {
    if (s.pass === undefined) continue;
    const entry = byMetric.get(s.metric) ?? { metric: s.metric, graderId: s.graderId, passes: [] };
    entry.passes.push(s.pass);
    if (s.pass === false && entry.failedBy === undefined) entry.failedBy = s.graderId;
    byMetric.set(s.metric, entry);
  }
  return [...byMetric.values()].map((e) => {
    const pass = e.passes.every(Boolean);
    return { metric: e.metric, graderId: pass ? e.graderId : (e.failedBy ?? e.graderId), pass };
  });
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

  // A REQUIRED metric with no measurement invalidates the case (its declared missingPolicy) — a verdict
  // standing on a hole it declared essential is not a verdict, and the absence states its cause.
  for (const d of policy.metrics) {
    if (d.verdictRole !== "required") continue;
    if ((d.missingPolicy ?? "invalidate_case") !== "invalidate_case") continue;
    if (!measured.some((s) => metricMatches(d.match, s.metric))) {
      const metric = "metric" in d.match ? d.match.metric : `${d.match.prefix}*`;
      return { invalidated: { reason: "required_metric_missing", metric } };
    }
  }

  const candidates = dedupeByMetric(measured).filter((c) => {
    // diagnostic/excluded metrics explain or observe — they never decide (stripped before any rung).
    const def = policy.metrics.find((d) => metricMatches(d.match, c.metric));
    return def?.verdictRole !== "diagnostic" && def?.verdictRole !== "excluded";
  });

  // Index each pass-bearing metric to its first matching definition (declaration order = priority).
  const matched = new Map<string, number>(); // metric → definition index
  for (const c of candidates) {
    const idx = policy.metrics.findIndex((d) => metricMatches(d.match, c.metric));
    if (idx >= 0) matched.set(c.metric, idx);
  }

  for (const authority of ["ground_truth", "objective", "judge"] as const) {
    const deciders = candidates
      .filter((c) => {
        const idx = matched.get(c.metric);
        return idx !== undefined && policy.metrics[idx]?.authority === authority;
      })
      .sort((a, b) => (matched.get(a.metric) ?? 0) - (matched.get(b.metric) ?? 0));
    if (deciders.length === 0) continue;
    const aggregation = policy.rungs[authority];
    return { verdict: combine(aggregation, deciders), basis: { authority, aggregation, deciders } };
  }

  if (policy.fallback === "none") return {};
  // Fallback: measured pass-bearing scores the policy has NEVER SEEN — undeclared metrics only.
  // Observational is verdict-INERT by definition ("measured but not pass-deciding"): a declared
  // observational metric that happens to carry a pass must not decide a case just because no rung did —
  // that would make the declaration weaker than saying nothing at all.
  const rest = candidates.filter((c) => matched.get(c.metric) === undefined);
  if (rest.length === 0) return {};
  return {
    verdict: combine(policy.fallback, rest),
    basis: { authority: "fallback", aggregation: policy.fallback, deciders: rest },
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
