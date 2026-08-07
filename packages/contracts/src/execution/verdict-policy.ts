import { z } from "zod";

// Verdict policy — the authority ladder as DATA instead of hardcoded metric-name arrays. The old
// implementation understood strings ("state", "judge") rather than meanings: a new ground-truth grader
// needed a domain edit to gain authority, a differently-named metric of the same nature had none, and the
// judge rung matched a literal that real judges (`judge:<id>`) never produced. A policy declares which
// metrics carry which authority and how each rung combines its measurements — and it is versioned +
// digested, because the verdict is derived at read time: without the stamp, editing this policy would
// silently rewrite every historical verdict. docs/architecture/eval-domain-model.md + trust-kernel contract ③.

export const MetricAuthoritySchema = z.enum([
  "ground_truth", // real state/test verification — nothing overturns it
  "objective", // deterministic comparison (answer/url/dom match)
  "judge", // model opinion — decides only when nothing objective exists
  "observational", // measured but not pass-deciding by itself (cost/steps/latency)
]);
export type MetricAuthority = z.infer<typeof MetricAuthoritySchema>;

// How a rung combines multiple deciding measurements:
// priority — the first definition (in declaration order) with a deciding measurement wins
// all — every deciding measurement must pass (unanimous)  ·  any — one pass suffices
// majority — strictly more passes than fails
export const VerdictAggregationSchema = z.enum(["priority", "all", "any", "majority"]);
export type VerdictAggregation = z.infer<typeof VerdictAggregationSchema>;

// Which metrics a definition covers. `metric` = exact name. `prefix` = name starts with it; `segments`
// optionally pins the TOTAL `:`-segment count so "judge:" can cover the top-level verdict (`judge:<id>`,
// 2 segments) without swallowing its diagnostic children (`judge:<id>:<criterion>`, 3+).
export const MetricMatcherSchema = z.union([
  z.object({ metric: z.string().min(1) }),
  z.object({ prefix: z.string().min(1), segments: z.number().int().positive().optional() }),
]);
export type MetricMatcher = z.infer<typeof MetricMatcherSchema>;

export const MetricDefinitionSchema = z.object({
  match: MetricMatcherSchema,
  authority: MetricAuthoritySchema,
  // Reading direction for numeric deltas (diff/comparability): absent = unknown → a consumer must not
  // interpret the delta's sign as improvement/regression.
  direction: z.enum(["higher_is_better", "lower_is_better", "neutral"]).optional(),
  // Value kind — declares what the number MEANS (a boolean 0/1, a real numeric, a categorical ordering key).
  // Absent = inferred (label presence ⇒ categorical). The diff layer flags a kind change as incomparable.
  kind: z.enum(["boolean", "numeric", "categorical"]).optional(),
  // What this metric may do to the verdict. Absent = "supporting" (decides on its rung, as before).
  // required   — the case CANNOT have a verdict without a measured score of this metric (see missingPolicy)
  // supporting — decides on its authority rung when present (the default)
  // diagnostic — explains, never decides (a criterion/milestone-style metric)
  // excluded   — never touches the verdict at all
  verdictRole: z.enum(["required", "supporting", "diagnostic", "excluded"]).optional(),
  // With verdictRole "required": what a MISSING measurement does. "invalidate_case" (default) — the case has
  // no verdict (unmeasured; a verdict standing on a hole it declared essential is not a verdict);
  // "exclude_metric" — proceed without it (the metric merely stops contributing).
  missingPolicy: z.enum(["invalidate_case", "exclude_metric"]).optional(),
});
export type MetricDefinition = z.infer<typeof MetricDefinitionSchema>;

// Which CASES a per-case policy clause covers. Same grammar as MetricMatcher minus `segments` (case ids
// have no `:`-segment convention): `caseId` = exact id, `prefix` = id starts with it, so a whole family
// ("auth/") is nameable without listing every row.
export const CaseMatcherSchema = z.union([
  z.object({ caseId: z.string().min(1) }),
  z.object({ prefix: z.string().min(1) }),
]);
export type CaseMatcher = z.infer<typeof CaseMatcherSchema>;

export const VerdictPolicySchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  // Declaration order is the priority order inside a "priority" rung.
  metrics: z.array(MetricDefinitionSchema),
  // Per-rung combination rule. Rungs are consulted strictly in authority order (ground_truth → objective →
  // judge); the first rung with a deciding measurement settles the case.
  rungs: z.object({
    ground_truth: VerdictAggregationSchema,
    objective: VerdictAggregationSchema,
    judge: VerdictAggregationSchema,
  }),
  // When NO declared rung decides: combine the remaining measured pass-bearing scores this way, or "none"
  // (undeclared metrics never decide — strict mode).
  fallback: z.union([VerdictAggregationSchema, z.literal("none")]),
  // Cases whose failure is a PRODUCT judgment that precedes statistics: a login case going 3/3 → 0/3 is an
  // honestly non-significant Fisher p=0.1, and shipping a fully broken login on that arithmetic is still
  // wrong. A release gate blocks on a critical case's collapse regardless of significance and regardless of
  // its regression budget. Criticality lives HERE, in the versioned+digested policy document, because it
  // changes what a gate decision means: the stamp is what keeps a historical decision re-derivable.
  criticalCases: z.array(CaseMatcherSchema).optional(),
});
export type VerdictPolicy = z.infer<typeof VerdictPolicySchema>;

// The stamp a scorecard carries: WHICH policy produced its verdicts. Verdicts are derived on read, so the
// stamp is what keeps a historical verdict stable when the policy evolves — resolve the stamped policy,
// never silently the newest one.
export const VerdictPolicyRefSchema = z.object({
  id: z.string(),
  version: z.string(),
  digest: z.string(), // content digest of the policy document (domain verdictPolicyDigest)
});
export type VerdictPolicyRef = z.infer<typeof VerdictPolicyRefSchema>;

export function metricMatches(matcher: MetricMatcher, metric: string): boolean {
  if ("metric" in matcher) return matcher.metric === metric;
  if (!metric.startsWith(matcher.prefix)) return false;
  return matcher.segments === undefined || metric.split(":").length === matcher.segments;
}

export function caseMatches(matcher: CaseMatcher, caseId: string): boolean {
  return "caseId" in matcher ? matcher.caseId === caseId : caseId.startsWith(matcher.prefix);
}
