import { JudgeSpecSchema } from "../../harness/judge-spec.js";

// GET /judges/:id/versions/:version 200 — the full JudgeSpec. SSOT: @everdict/core.
export const JudgeResponseSchema = JudgeSpecSchema;
