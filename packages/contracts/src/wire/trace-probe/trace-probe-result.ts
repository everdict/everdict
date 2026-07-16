import { z } from "zod";

// POST /workspace/trace-{sources,sinks}/probe 200 — connection-test + scope-discovery outcome.
// Mirrors TraceProbeResult (execution/trace-probe.ts) and is the parse boundary the web drift-guards against.
// A classified failure (reason set, reachable=false) is still a 200 — the same convention as runtime-probe.
export const TraceScopeOptionSchema = z.object({
  id: z
    .string()
    .describe("Value stored on the config (mlflow experiment_id, phoenix/langsmith project id, otel service)"),
  name: z.string().describe("Human label shown in the scope picker"),
});
export type TraceScopeOption = z.infer<typeof TraceScopeOptionSchema>;

export const TraceProbeResultSchema = z.object({
  kind: z.string().describe("Platform kind that was probed"),
  reachable: z.boolean(),
  detail: z.string().describe("Human-readable probe detail"),
  reason: z
    .enum(["auth", "unreachable", "error"])
    .optional()
    .describe("Structured failure class — absent when reachable"),
  scopeKind: z
    .enum(["experiment", "project", "service"])
    .optional()
    .describe("What the scopes list represents for this kind"),
  scopes: z
    .array(TraceScopeOptionSchema)
    .optional()
    .describe("Selectable platform scopes discovered in the probe — present (possibly empty) only when reachable"),
});
export type TraceProbeResult = z.infer<typeof TraceProbeResultSchema>;
