import { z } from "zod";
import { PortabilityIssueSchema } from "./portability-issue.js";

// POST /harness-templates/validate 200 — dry-run outcome. Schema failures come back as ok:false (not 400).
export const ValidateHarnessTemplateResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    kind: z.string().describe("Template kind (command | service | process)"),
    id: z.string(),
    version: z.string(),
    existingVersions: z.array(z.string()).describe("Versions this workspace registered directly (no _shared fallback)"),
    versionExists: z.boolean().describe("True when the submitted version collides with an existing one"),
    portabilityIssues: z
      .array(PortabilityIssueSchema)
      .optional()
      .describe(
        "Cross-runtime portability findings on the service topology (present only when non-empty; errors + warnings). " +
          "Surfaced at authoring time so the wizard anchors each to its service/field.",
      ),
  }),
  z.object({
    ok: z.literal(false),
    errors: z.array(z.string()).describe("Schema issues (path: message)"),
    existingVersions: z.array(z.string()),
    versionExists: z.boolean(),
  }),
]);
export type ValidateHarnessTemplateResult = z.infer<typeof ValidateHarnessTemplateResultSchema>;
