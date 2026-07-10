import { z } from "zod";
import { ScorecardRecordSchema } from "../../records/scorecard.js";

// GET /scorecards — the workspace's scorecard records. The store's list view omits the heavy per-case
// fields (scorecard/steps/runIds/export are optional on the record and absent here).
export const ScorecardListResponseSchema = z.array(ScorecardRecordSchema);
