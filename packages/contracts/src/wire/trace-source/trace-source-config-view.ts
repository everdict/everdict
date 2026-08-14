import { z } from "zod";

// One trace source's status (TraceSourceService.TraceSourceConfigView). No secrets — authSecretName is a
// SecretStore name reference; the auth value is resolved only at pull time and never returned.
export const TraceSourceConfigViewSchema = z.object({
  name: z.string().describe("Source name (reference key — per-harness selection points at this name)"),
  kind: z.enum(["otel", "mlflow", "langfuse", "langsmith", "phoenix"]),
  endpoint: z.string().describe("Platform query API base URL (reachable from the control plane at pull time)"),
  authSecretName: z.string().optional().describe("SecretStore name of the auth-header value (never the value)"),
  correlate: z
    .enum(["id", "tag"])
    .describe("id = the everdict runId IS the trace id | tag = search the everdict.run_id the deployed agent tagged"),
  correlateTag: z
    .string()
    .optional()
    .describe("the controlled tag a correlate:'tag' search matches (otel Jaeger tag key / mlflow session tag)"),
  service: z.string().optional().describe("otel/jaeger tag-search scope (the agent's service.name)"),
  project: z
    .string()
    .optional()
    .describe(
      "scope per kind: mlflow experiment_id / phoenix|langfuse|langsmith project (required for mlflow/phoenix)",
    ),
  webUrl: z.string().optional().describe("export deep-link base when it differs from the endpoint (export-target use)"),
  artifactBaseUrl: z
    .string()
    .optional()
    .describe("base URL for root-relative artifact refs in pulled traces (evidence resolution; pull-only)"),
});
export type TraceSourceConfigView = z.infer<typeof TraceSourceConfigViewSchema>;

// PUT /workspace/trace-sources — the stored source after the name-keyed upsert.
export const TraceSourceUpsertResponseSchema = z.object({
  config: TraceSourceConfigViewSchema,
});
export type TraceSourceUpsertResponse = z.infer<typeof TraceSourceUpsertResponseSchema>;
