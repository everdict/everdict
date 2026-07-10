import type { z } from "zod";
import { RuntimeSpecSchema } from "../../infra/runtime-spec.js";

// GET /runtimes/:id/versions/:version 200 — the full RuntimeSpec. SSOT: @everdict/contracts.
export const RuntimeResponseSchema = RuntimeSpecSchema;
export type RuntimeResponse = z.infer<typeof RuntimeResponseSchema>;
