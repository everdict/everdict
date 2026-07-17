import { SpanAttrMappingSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Trace-source MCP tools — the MCP twin of trace-source.routes.ts (the inbound mirror of the trace-sink tools).
export function registerTraceSourceTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  // Workspace trace sources (multiple) — pull a dev-cluster-deployed harness's trace from its observability platform after a
  // case runs. Register by name and select 'per harness'. Read harnesses:read / register·remove settings:write / select harnesses:register.
  if (deps.traceSourceService) {
    const source = deps.traceSourceService;
    server.registerTool(
      "list_workspace_trace_sources",
      {
        description:
          "This workspace's trace sources + per-harness selection state — {sources:[{name,kind,endpoint,correlate,…}], assignments:{harnessId→sourceName}} (not secret values).",
        inputSchema: {},
      },
      () => run(principal, "harnesses:read", async () => ok(await source.list(ws))),
    );
    server.registerTool(
      "set_workspace_trace_source",
      {
        description:
          "Register/update a trace source (admin, upsert by name). One pool: a harness uses it to PULL its trace from and/or to EXPORT judged results to (that direction is a per-harness choice). Put the auth token (value) in the SecretStore first and pass its name as authSecretName. `project` is required for mlflow (experiment) and phoenix; otel correlate:'tag' needs service.",
        inputSchema: {
          name: z.string().min(1).describe("source name (reference key — per-harness selection points at this name)"),
          kind: z.enum(["otel", "mlflow", "langfuse", "langsmith", "phoenix"]).describe("observability platform kind"),
          endpoint: z.string().url().describe("platform query API base URL (reachable from the control plane)"),
          authSecretName: z
            .string()
            .min(1)
            .optional()
            .describe("SecretStore key name holding the auth-header 'value' (omit for an unauthenticated dev server)"),
          correlate: z
            .enum(["id", "tag"])
            .optional()
            .describe(
              "pull-only: id = runId IS the trace id (default) | tag = search the everdict.run_id the deployed agent tagged",
            ),
          service: z.string().min(1).optional().describe("otel/jaeger tag-search scope (the agent's service.name)"),
          project: z.string().min(1).optional().describe("mlflow experiment_id / phoenix|langfuse|langsmith project"),
          webUrl: z.string().url().optional().describe("export deep-link base when it differs from the endpoint"),
        },
      },
      (input) => run(principal, "settings:write", async () => ok({ config: await source.upsert(ws, input) })),
    );
    server.registerTool(
      "probe_workspace_trace_source",
      {
        description:
          "Test a trace source connection (base URL + resolved secret) and list the platform's selectable scopes in one authed call — validates before registering. Returns {kind, reachable, detail, reason?('auth'|'unreachable'|'error'), scopeKind?('experiment'|'project'|'service'), scopes?:[{id,name}]}. mlflow→experiments, phoenix/langfuse/langsmith→projects, otel→jaeger services (OTLP-native collectors return reachable with no list). Put the auth value in the SecretStore first and pass its name.",
        inputSchema: {
          kind: z.enum(["otel", "mlflow", "langfuse", "langsmith", "phoenix"]).describe("observability platform kind"),
          endpoint: z.string().url().describe("platform query API base URL"),
          authSecretName: z
            .string()
            .min(1)
            .optional()
            .describe("SecretStore key name holding the auth-header 'value' (omit for an unauthenticated dev server)"),
        },
      },
      (input) => run(principal, "settings:write", async () => ok(await source.probe(ws, input))),
    );
    server.registerTool(
      "remove_workspace_trace_source",
      {
        description:
          "Remove a trace source (admin, by name). Any per-harness selection pointing at it is cleaned up too.",
        inputSchema: { name: z.string().min(1).describe("name of the source to remove") },
      },
      ({ name }) =>
        run(principal, "settings:write", async () => {
          await source.remove(ws, name);
          return ok({ ok: true });
        }),
    );
    server.registerTool(
      "assign_harness_trace_source",
      {
        description:
          "Per-harness PULL selection (member+) — which registered source everdict pulls this harness's case traces from. Omit source to clear the selection (fall back to inline / no pull).",
        inputSchema: {
          harness: z.string().min(1).describe("harness id"),
          source: z.string().min(1).optional().describe("source name (omit = clear selection)"),
        },
      },
      ({ harness, source: sourceName }) =>
        run(principal, "harnesses:register", async () =>
          ok({ assignments: await source.assignSource(ws, harness, sourceName ?? null) }),
        ),
    );
    server.registerTool(
      "assign_harness_trace_sink",
      {
        description:
          "Per-harness EXPORT selection (member+) — which registered source this harness's judged scorecards export to (the source used as an export target; a sink-capable kind, not otel). Same pool as the pull selection. Omit source to clear (export off).",
        inputSchema: {
          harness: z.string().min(1).describe("harness id"),
          source: z
            .string()
            .min(1)
            .optional()
            .describe("source name used as an export target (omit = clear selection)"),
        },
      },
      ({ harness, source: sourceName }) =>
        run(principal, "harnesses:register", async () =>
          ok({ assignments: await source.assignSink(ws, harness, sourceName ?? null) }),
        ),
    );
    server.registerTool(
      "list_trace_source_traces",
      {
        description:
          "Enumerate a registered trace source's recent traces + observability metrics (id, name, startedAt, durationMs, tokens, costUsd, status, tags) — the list the judge wizard samples from and the settings traces view. scope defaults to the source's configured scope (mlflow experiment / phoenix|langfuse|langsmith project / otel[jaeger] service).",
        inputSchema: {
          name: z.string().min(1).describe("registered source name"),
          scope: z
            .string()
            .min(1)
            .optional()
            .describe("platform scope to list within (defaults to the source's configured scope)"),
          limit: z.number().int().positive().max(500).optional().describe("max traces (default 50)"),
          since: z.string().min(1).optional().describe("ISO-8601 lower time bound (best-effort)"),
        },
      },
      ({ name, scope, limit, since }) =>
        run(principal, "harnesses:read", async () =>
          ok({
            traces: await source.listTraces(ws, name, {
              ...(scope ? { scope } : {}),
              ...(limit ? { limit } : {}),
              ...(since ? { since } : {}),
            }),
          }),
        ),
    );
    server.registerTool(
      "inspect_trace",
      {
        description:
          "Inspect one trace by id — returns the events normalized with the SUPPLIED span-attribute mapping, plus (for span-based kinds otel/mlflow) the raw span attributes so a mapping can be authored against real keys. Native kinds (langfuse/langsmith/phoenix) ignore mapping and omit rawAttributes. Nothing is persisted.",
        inputSchema: {
          name: z.string().min(1).describe("registered source name"),
          traceId: z.string().min(1).describe("trace id (from list_trace_source_traces)"),
          mapping: SpanAttrMappingSchema.optional().describe(
            "span-attribute mapping to normalize with (span-based kinds)",
          ),
        },
      },
      ({ name, traceId, mapping }) =>
        run(principal, "harnesses:read", async () => ok(await source.inspect(ws, name, traceId, mapping))),
    );
  }

  // Per-harness span-attribute mapping overlay (the conversion layer between a harness and a judge). Read harnesses:read / set harnesses:register.
  if (deps.spanAttrMappingService) {
    const mappings = deps.spanAttrMappingService;
    server.registerTool(
      "get_harness_span_attr_mapping",
      {
        description:
          "This harness's span-attribute mapping overlay — the mutable conversion layer between a harness and a judge. null = no overlay (the run-time resolver uses the harness spec's mapping / OTel GenAI defaults).",
        inputSchema: { harness: z.string().min(1).describe("harness id") },
      },
      ({ harness }) =>
        run(principal, "harnesses:read", async () => ok({ mapping: (await mappings.get(ws, harness)) ?? null })),
    );
    server.registerTool(
      "set_harness_span_attr_mapping",
      {
        description:
          "Set/clear a harness's span-attribute mapping overlay (member+) — authored in the judge wizard against a real trace, applied at the trace-collection seams (overriding the harness spec's mapping). Omit mapping to clear.",
        inputSchema: {
          harness: z.string().min(1).describe("harness id"),
          mapping: SpanAttrMappingSchema.optional().describe("the mapping (omit = clear the overlay)"),
        },
      },
      ({ harness, mapping }) =>
        run(principal, "harnesses:register", async () =>
          ok({ mappings: await mappings.assign(ws, harness, mapping ?? null) }),
        ),
    );
  }
}
