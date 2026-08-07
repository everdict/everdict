import {
  type CaseFailure,
  type CaseResult,
  type GraderSpec,
  type MetricAuthority,
  type MetricDefinition,
  type Score,
  type VerdictAggregation,
  type VerdictPolicy,
  type VerdictPolicyRef,
  measuredScores,
  metricMatches,
} from "@everdict/contracts";
import { contentDigest } from "../provenance/content-digest.js";

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

// The historical authority ladder as a policy document. version bumps REQUIRE review (constitution-gated
// once O1 lands): verdicts are derived on read, so an unstamped edit here would rewrite history — the
// ScorecardBatch stamps this policy's ref at settle precisely so old records resolve their own policy.
export const DEFAULT_VERDICT_POLICY: VerdictPolicy = {
  id: "authority-ladder",
  version: "1.0.0",
  metrics: [
    // ground truth — declaration order is the priority order ("priority" rung): state beats tests_pass.
    { match: { metric: "state" }, authority: "ground_truth" },
    { match: { metric: "tests_pass" }, authority: "ground_truth" },
    // objective deterministic comparisons — unanimous.
    { match: { metric: "answer_match" }, authority: "objective" },
    { match: { metric: "url_matches" }, authority: "objective" },
    { match: { metric: "dom_contains" }, authority: "objective" },
    // judge verdicts: legacy "judge" and the real top-level `judge:<id>` (2 segments). Deeper metrics
    // (`judge:<id>:<criterion>`, milestones) are diagnostic localization and never decide.
    { match: { metric: "judge" }, authority: "judge" },
    { match: { prefix: "judge:", segments: 2 }, authority: "judge" },
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
const KNOWN_VERDICT_POLICIES: readonly VerdictPolicy[] = [DEFAULT_VERDICT_POLICY];

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
  if (!ref) return { status: "legacy_default", policy: DEFAULT_VERDICT_POLICY };
  if (embedded && (ref.digest === undefined || verdictPolicyDigest(embedded) === ref.digest))
    return { status: "resolved", policy: embedded };
  const known = KNOWN_VERDICT_POLICIES.find((p) => p.id === ref.id && p.version === ref.version);
  if (known && (ref.digest === undefined || verdictPolicyDigest(known) === ref.digest))
    return { status: "resolved", policy: known };
  return { status: "unresolvable", ref };
}

// Compose the batch's verdict policy from the run-time grading plan's DECLARATIONS: a custom grader gains
// authority for the metric sharing its id by declaring it — no domain-code edit. Declared definitions are
// appended AFTER the built-ins, so a custom ground-truth ranks below state/tests_pass in the priority rung
// (adding a source of truth never silently outranks the established ones). No declarations ⇒ the base policy
// object itself (identity-comparable, so callers can tell "nothing composed").
export function composeVerdictPolicy(
  specs: readonly Pick<GraderSpec, "id" | "authority" | "direction">[],
  base: VerdictPolicy = DEFAULT_VERDICT_POLICY,
): VerdictPolicy {
  const additions: MetricDefinition[] = [];
  for (const spec of specs) {
    if (spec.authority === undefined) continue;
    additions.push({
      match: { metric: spec.id },
      authority: spec.authority,
      ...(spec.direction ? { direction: spec.direction } : {}),
    });
  }
  if (additions.length === 0) return base;
  const doc: VerdictPolicy = { ...base, id: "composed", version: "0", metrics: [...base.metrics, ...additions] };
  // The version IS the content identity — composed documents have no registry row to version against.
  return { ...doc, version: verdictPolicyDigest(doc).slice(0, 12) };
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
// one deciding value per metric.
function dedupeByMetric(scores: Score[]): Array<{ metric: string; graderId: string; pass: boolean }> {
  const byMetric = new Map<string, { metric: string; graderId: string; passes: boolean[] }>();
  for (const s of scores) {
    if (s.pass === undefined) continue;
    const entry = byMetric.get(s.metric) ?? { metric: s.metric, graderId: s.graderId, passes: [] };
    entry.passes.push(s.pass);
    byMetric.set(s.metric, entry);
  }
  return [...byMetric.values()].map((e) => ({ metric: e.metric, graderId: e.graderId, pass: e.passes.every(Boolean) }));
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
  // Fallback: measured pass-bearing scores not claimed by a deciding rung (observational definitions land
  // here too — declared-but-not-deciding is the same as undeclared for the verdict).
  const rest = candidates.filter((c) => {
    const idx = matched.get(c.metric);
    if (idx === undefined) return true;
    const authority = policy.metrics[idx]?.authority;
    return authority === "observational";
  });
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

export function verdictPolicyRef(policy: VerdictPolicy = DEFAULT_VERDICT_POLICY): VerdictPolicyRef {
  return { id: policy.id, version: policy.version, digest: verdictPolicyDigest(policy) };
}
