import { ScorecardRecordSchema } from "../../records/scorecard.js";

// Response DTO — a scorecard record (batch eval). The @everdict/db ScorecardRecordSchema is the SSOT shape.
// get() also carries the heavy detail fields (scorecard/steps/runIds/export) — all optional on the record.
export const ScorecardResponseSchema = ScorecardRecordSchema;
