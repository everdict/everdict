import { RuntimeSpecSchema } from "../../infra/runtime-spec.js";

// GET /runtimes/:id/versions/:version 200 — the full RuntimeSpec. SSOT: @everdict/core.
export const RuntimeResponseSchema = RuntimeSpecSchema;
