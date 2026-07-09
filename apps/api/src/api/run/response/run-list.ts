import { RunRecordSchema } from "@everdict/db";
import { z } from "zod";

// GET /runs — the workspace's run records. Default view hides scorecard child runs (activity list);
// with ?scorecardId only that batch's children are returned (case drill-down).
export const RunListResponseSchema = z.array(RunRecordSchema);
