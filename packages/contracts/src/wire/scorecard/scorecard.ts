import { z } from "zod";
import { CaseResultSchema, ScorecardSchema } from "../../execution/eval-case.js";
import { ScorecardOutcomesSchema, ScorecardRecordSchema } from "../../records/scorecard.js";

// Response DTO — a scorecard record (batch eval). The @everdict/db ScorecardRecordSchema is the SSOT shape.
// get() also carries the heavy detail fields (scorecard/steps/runIds/export) — all optional on the record.
//
// The detail response additionally carries server-computed derivations (re-architecture P1g) so no
// client re-implements the rules: per-case `verdict` (authority rank: ground-truth > objective >
// judge), the `casePass` rollup, and the trial-aware `headlinePassRate` — all computed at serve time
// (old records get them too) by apps/api api/scorecard/serve.ts from @everdict/domain rules.
export const ServedCaseResultSchema = CaseResultSchema.extend({
  verdict: z
    .boolean()
    .optional()
    .describe(
      "Server-computed case verdict (state/tests_pass > answer_match/url_matches/dom_contains > judge); absent = no pass-deciding score",
    ),
  verdictBasis: z
    .object({
      authority: z.enum(["ground_truth", "objective", "judge", "observational", "fallback"]),
      aggregation: z.enum(["priority", "all", "any", "majority"]),
      deciders: z.array(z.object({ metric: z.string(), graderId: z.string(), pass: z.boolean() })),
    })
    .optional()
    .describe(
      "How the verdict was decided: the rung that settled it, its aggregation rule, and the exact measurements that voted — a verdict that cannot explain itself cannot be defended",
    ),
  evidenceStatus: z
    .object({
      trace: z.enum(["complete", "partial", "missing", "deferred"]),
      snapshot: z.enum(["complete", "missing"]),
    })
    .optional()
    .describe(
      "Evidence completeness derived from the result (collect failures, placeholder snapshots) — a verdict standing on partial evidence says so",
    ),
});
export type ServedCaseResult = z.infer<typeof ServedCaseResultSchema>;

export const ScorecardResponseSchema = ScorecardRecordSchema.extend({
  scorecard: ScorecardSchema.extend({ results: z.array(ServedCaseResultSchema) }).optional(),
  casePass: z
    .object({ pass: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
    .optional()
    .describe("Case-level verdict rollup over results (server-computed; present when per-case results are present)"),
  headlinePassRate: z
    .number()
    .nullable()
    .optional()
    .describe(
      "Single headline pass rate — trial-aware (passAt1), else highest-authority metric pass rate; null = nothing pass-deciding",
    ),
  retryableUnmeasured: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Transient scoring failures a targeted re-score (POST /scorecards/:id/rescore-unmeasured) can recover — present when > 0",
    ),
  outcomes: ScorecardOutcomesSchema.optional().describe(
    "Case-fate denominators (server-computed; present when per-case results are present): executed/gradeable/verdicted + passed/failed/infraFailed/unmeasured — an infra-failed case has no product verdict and never enters pass rate",
  ),
  policyResolution: z
    .enum(["resolved", "legacy_default", "unresolvable"])
    .optional()
    .describe(
      "Whether this batch's STAMPED verdict policy could be restored (detail only). 'unresolvable' = the stamped document is gone, so no verdict can be re-derived: per-case `verdict`, `casePass` and `outcomes` are ABSENT rather than silently re-judged under today's default ladder",
    ),
});
export type ScorecardResponse = z.infer<typeof ScorecardResponseSchema>;
