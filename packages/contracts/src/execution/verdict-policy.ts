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

// THE NAMES THAT CARRY BUILT-IN AUTHORITY — reserved, because in this system a metric NAME is what assigns
// authority (arch-review 17 P0-2).
//
// The default ladder maps `state`/`tests_pass` to ground_truth and `answer_match`/`url_matches`/`dom_contains`
// to objective, and a custom grader gains authority by DECLARING it on its GraderSpec — a declaration that is
// constitution-gated (ground_truth is admin-only at submit), precisely because whoever can name new ground
// truth decides what passing MEANS.
//
// The gate was on the declaration and not on the NAME, and the name is producer-controlled: a custom script
// prints whatever `metric` it likes and the collector stamps only `graderId`. So an undeclared grader
// emitting `{"metric": "state", "value": 1, "pass": true}` was read as ground truth by the default policy —
// the authority of a declaration nobody made. The right to name ground truth and the right to be believed as
// ground truth have to be the same right.
//
// Kept HERE, beside the authority vocabulary, so the producer boundary (`sanitizeScore`) can enforce it
// without reaching into the domain — the ladder itself stays a frozen document in `@everdict/domain`, and a
// test asserts this list is exactly its authority-bearing exact matchers rather than a second hand-written
// copy of them.
export const RESERVED_AUTHORITY_METRICS: readonly string[] = [
  "state",
  "tests_pass",
  "answer_match",
  "url_matches",
  "dom_contains",
];

// The judge family's root. Only a JUDGE may produce `judge` / `judge:<id>` / `judge:<id>:<criterion>` — a
// grader emitting into it would forge a verdict, and (worse) the family it forged into is the unit re-scoring
// strips and replaces, so the row would survive every later pass of the judge whose name it wears.
export const JUDGE_METRIC_ROOT = "judge";

// Is this a name the CONSTITUTION already owns? (arch-review 20 P0-1)
//
// The reserved authority metrics and the whole judge family. A user declaration may describe the semantics of
// a name it introduces; it may not take over one the built-in ladder already assigns meaning to — otherwise
// "declaring" a metric is a way to be READ as ground truth without ever asking for ground truth, which is the
// admin gate's whole subject.
export function isConstitutionalMetric(metric: string): boolean {
  return (
    RESERVED_AUTHORITY_METRICS.includes(metric) ||
    metric === JUDGE_METRIC_ROOT ||
    metric.startsWith(`${JUDGE_METRIC_ROOT}:`)
  );
}

// WHO produced a score — supplied by the collection boundary, never by the producer. This is the whole point:
// authority must be stamped by something the producer cannot speak for.
//
// Ownership is INTRINSIC, not declared (arch-review 18 P0-1). The first version treated "this grader declared
// SOME authority" as the permit, which made a declaration a wildcard: a custom grader declaring
// `authority: "observational"` — a declaration needing no admin — could print `{"metric": "state"}` and the
// ladder still read it as ground truth. The gate moved from "did you declare ground truth" to "did you
// declare anything", which is not the same question and is not a gate.
//
// A declaration authorizes DECLARED SEMANTICS for the producer's own metric (that is exactly what
// `GraderSpec.authority` says: the semantics of "the metric sharing its id", composed into the batch policy).
// It authorizes nothing about labels that already carry authority. So the reserved names belong to the
// producers that own them by construction, and no spec can hand them over.
export type ScoreProducer =
  | {
      kind: "grader";
      id: string;
      // Reserved metric names this grader owns BY CONSTRUCTION — declared on the implementation, whose metric
      // is fixed in its own code rather than taken from config or from a script's stdout. Never sourced from
      // a spec: a spec is user data, and this is the capability the rule exists to protect.
      ownsMetrics?: readonly string[];
      // May emit the inline judge's shapes (`judge`, `judge:<criterion>`). The JudgeGrader implementation owns
      // it; so does the code-judge WRAPPER, whose spec the control plane builds — see `forgedMetricReason`
      // for the exact bound and the residual it leaves.
      ownsJudgeVerdict?: boolean;
    }
  | { kind: "judge"; id: string };

// May this producer emit this metric? Pure and total — the reason, or undefined when it may.
export function forgedMetricReason(metric: string, producer: ScoreProducer): string | undefined {
  const inJudgeFamily = metric === JUDGE_METRIC_ROOT || metric.startsWith(`${JUDGE_METRIC_ROOT}:`);
  if (producer.kind === "judge") {
    // A judge owns exactly its OWN family. The code-judge path rewrites a leading `judge` into `judge:<id>`,
    // so a raw metric of anything else (`state`, say) passed through untouched and arrived carrying whatever
    // authority that name has — a judge escalating itself to ground truth.
    const own = `${JUDGE_METRIC_ROOT}:${producer.id}`;
    if (metric === own || metric.startsWith(`${own}:`)) return undefined;
    return `a judge may only produce its own metric family ('${own}' or '${own}:<criterion>'); '${metric}' belongs to something else`;
  }
  if (inJudgeFamily) {
    if (producer.ownsJudgeVerdict !== true)
      return `'${metric}' belongs to the judge family, which only a judge may produce — a grader writing into it would forge a verdict and own rows a re-score cannot replace`;
    // Criteria are multi-segment by design (`judge:milestone:<id>` is a real code-judge shape), so no depth
    // bound is meaningful here — and none is needed on the registered path, where the runner rewrites every
    // metric to `judge:<thisJudgeId>…` before it reaches the plane. A forged name cannot survive that.
    //
    // The residual, stated rather than hidden: for the INLINE judge grader, whose scores are not rewritten,
    // `judge:x` is syntactically a criterion named `x` and the family of a judge called `x` at the same time.
    // A grader granted the judge verdict can therefore land a judge-RUNG row in a registered judge's family.
    // It is bounded — the weakest deciding rung, and inside that family, so a re-score of that judge replaces
    // it rather than leaving it stale — and it is exactly the ambiguity that structured score identity
    // (producer, metric and criterion as FIELDS rather than as one string) removes for good. Until then this
    // is the honest edge of a name-based namespace, not a gap anyone can widen.
    return undefined;
  }
  if (RESERVED_AUTHORITY_METRICS.includes(metric) && !(producer.ownsMetrics ?? []).includes(metric))
    return `'${metric}' carries built-in verdict authority and belongs to the grader that produces it; declaring an authority does not grant another producer's name — use this grader's own metric name and declare \`authority\` for that`;
  return undefined;
}

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
