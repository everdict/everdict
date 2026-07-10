import { z } from "zod";
import { CaseResultSchema, ScorecardSchema } from "../../execution/eval-case.js";
import { ScorecardRecordSchema } from "../../records/scorecard.js";

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
});

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
});
export type ScorecardResponse = z.infer<typeof ScorecardResponseSchema>;
