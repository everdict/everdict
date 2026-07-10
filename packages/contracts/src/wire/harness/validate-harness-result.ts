import { z } from "zod";
import { ImageWarningSchema } from "./image-warning.js";

// POST /harnesses/validate 200 — dry-run outcome. Schema/template/pin failures come back as ok:false (not 400).
export const ValidateHarnessResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    kind: z.string().describe("Resolved harness kind (command | service | process)"),
    id: z.string(),
    version: z.string(),
    imageWarnings: z.array(ImageWarningSchema).optional().describe("Present only when non-empty (warn-not-block)"),
  }),
  z.object({
    ok: z.literal(false),
    errors: z.array(z.string()).describe("Schema issues or the resolve failure message"),
  }),
]);
export type ValidateHarnessResult = z.infer<typeof ValidateHarnessResultSchema>;
