import { z } from "zod";
import { MetricSummarySchema } from "../../records/scorecard.js";

// POST /scorecards/query — flexible analysis pivot over the workspace's scorecards
// (@everdict/domain AnalysisResult; undefined cell/point values serialize as null/absent over the wire).
export const AnalysisGridRowSchema = z.object({
  key: z.string().describe("Opaque group key (unit-separator-joined dimension values)"),
  labels: z.array(z.string()).describe("Raw label per groupBy dimension (owner = the subject)"),
  count: z.number().int().describe("Scorecards in the group"),
  value: z.number().optional().describe("Measured value over the whole group"),
  cells: z
    .array(z.object({ key: z.string(), value: z.number().optional() }))
    .describe("Value per pivot column ([] when no pivotBy)"),
});

export const ScorecardAnalysisResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("grid"),
    rows: z.array(AnalysisGridRowSchema),
    pivotKeys: z.array(z.string()).describe("pivotBy values (sorted); [] if none"),
    metric: z.string().optional(),
    total: z.number().int().describe("Scorecards that passed the filters"),
  }),
  z.object({
    kind: z.literal("line"),
    buckets: z.array(z.string()).describe("Time buckets (sorted)"),
    series: z.array(z.object({ label: z.string(), points: z.array(z.number().nullable()) })),
    metric: z.string().optional(),
    total: z.number().int(),
  }),
]);
export type ScorecardAnalysisResponse = z.infer<typeof ScorecardAnalysisResponseSchema>;

// GET /scorecards/:id/analysis — the offloaded per-batch analysis bundle (analysisRef), fetched server-side.
// Shape mirror of @everdict/application-control's AnalysisBundle (the offloadAnalysis payload) — kept in lockstep.
export const ScorecardAnalysisBundleResponseSchema = z.object({
  scorecardId: z.string(),
  dataset: z.string().describe('"id@version"'),
  harness: z.string().describe('"id@version"'),
  summary: z.array(MetricSummarySchema),
  cases: z.array(
    z.object({
      caseId: z.string(),
      verdict: z.boolean().optional().describe("Authority-ranked case pass/fail (absent when no grader decided)"),
      scores: z.array(z.unknown()).describe("Score[] as graded"),
      failure: z.unknown().optional().describe("Classified failure (when the case failed)"),
    }),
  ),
});
export type ScorecardAnalysisBundleResponse = z.infer<typeof ScorecardAnalysisBundleResponseSchema>;
