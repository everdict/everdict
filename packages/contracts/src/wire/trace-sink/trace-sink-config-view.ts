import { z } from "zod";

// One trace sink's status (TraceSinkService.TraceSinkConfigView). No secrets — authSecretName is a
// SecretStore name reference; the auth value is resolved only at export time and never returned.
export const TraceSinkConfigViewSchema = z.object({
  name: z.string().describe("Sink name (reference key — per-harness selection points at this name)"),
  kind: z.enum(["mlflow", "langfuse", "langsmith", "phoenix"]),
  endpoint: z.string().describe("Platform API base URL"),
  authSecretName: z.string().optional().describe("SecretStore name of the auth-header value (never the value)"),
  project: z
    .string()
    .optional()
    .describe("Meaning per kind: mlflow experiment_id / langsmith project / phoenix project / langfuse projectId"),
  webUrl: z.string().optional().describe("UI deep-link base when it differs from the API endpoint"),
});
export type TraceSinkConfigView = z.infer<typeof TraceSinkConfigViewSchema>;

// PUT /workspace/trace-sinks — the stored sink after the name-keyed upsert.
export const TraceSinkUpsertResponseSchema = z.object({
  config: TraceSinkConfigViewSchema,
});
export type TraceSinkUpsertResponse = z.infer<typeof TraceSinkUpsertResponseSchema>;
