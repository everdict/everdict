import { z } from "zod";
import { RunRecordSchema } from "../../records/run.js";

// GET /runs — the workspace's run records. Default view hides scorecard child runs (activity list);
// with ?scorecardId only that batch's children are returned (case drill-down).
//
// A batch's children include SUPERSEDED attempts (a retried case keeps its abandoned run parented here), and
// the list served them unlabelled — indistinguishable from the attempt the batch actually stands on. The
// batch's commit receipts already decide that; `canonical` carries the decision onto each row.
export const RunListItemSchema = RunRecordSchema.extend({
  canonical: z
    .boolean()
    .optional()
    .describe(
      "Whether this child run is the one its batch's commit receipt named for its (case, trial): true = the batch's evidence, false = a superseded attempt of a receipted case. ABSENT when the row is not a batch child, or its case has no receipt (pre-receipt records) — absence means unknown, never false",
    ),
});
export type RunListItem = z.infer<typeof RunListItemSchema>;

export const RunListResponseSchema = z.array(RunListItemSchema);
export type RunListResponse = z.infer<typeof RunListResponseSchema>;
