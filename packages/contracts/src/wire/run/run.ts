import type { z } from "zod";
import { RunRecordSchema } from "../../records/run.js";

// Response DTO — a run record. The @everdict/db RunRecordSchema is the SSOT shape (rule api-layer:
// response/ reuses the record schema, never redefines it).
export const RunResponseSchema = RunRecordSchema;
export type RunResponse = z.infer<typeof RunResponseSchema>;
