import { z } from "zod";
import { ScorecardRecordSchema } from "../../records/scorecard.js";

// GET /scorecards — the workspace's scorecard records. The store's list view omits the heavy per-case
// fields (scorecard/steps/runIds/export are optional on the record and absent here). Each row ADDITIONALLY
// carries the served `headlinePassRate` (serveScorecardListItem) — the authority-ranked representative a
// client reads instead of re-deriving one from summary order; the spec must say so or the served field
// reads as undocumented surface.
export const ScorecardListItemSchema = ScorecardRecordSchema.extend({
  headlinePassRate: z
    .number()
    .nullable()
    .optional()
    .describe(
      "Single headline pass rate — trial-aware (passAt1), else highest-authority metric pass rate; null = nothing pass-deciding",
    ),
});
export type ScorecardListItem = z.infer<typeof ScorecardListItemSchema>;

export const ScorecardListResponseSchema = z.array(ScorecardListItemSchema);
export type ScorecardListResponse = z.infer<typeof ScorecardListResponseSchema>;
