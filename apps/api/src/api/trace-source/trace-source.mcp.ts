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
          "Register/update a trace source (admin, upsert by name). When a harness selects this source, everdict pulls that case's trace from this platform after the run and grades/judges it. Put the auth token (value) in the SecretStore first and pass its name as authSecretName. correlate:'tag' needs service (otel) or project (mlflow/phoenix).",
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
              "id = runId IS the trace id (default) | tag = search the everdict.run_id the deployed agent tagged",
            ),
          service: z.string().min(1).optional().describe("otel/jaeger tag-search scope (the agent's service.name)"),
          project: z.string().min(1).optional().describe("mlflow experiment_id / phoenix project (tag/span scope)"),
        },
      },
      (input) => run(principal, "settings:write", async () => ok({ config: await source.upsert(ws, input) })),
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
          "Per-harness trace source selection (member+) — which registered source everdict pulls this harness's case traces from. Omit source to clear the selection (fall back to inline / no pull).",
        inputSchema: {
          harness: z.string().min(1).describe("harness id"),
          source: z.string().min(1).optional().describe("source name (omit = clear selection)"),
        },
      },
      ({ harness, source: sourceName }) =>
        run(principal, "harnesses:register", async () =>
          ok({ assignments: await source.assign(ws, harness, sourceName ?? null) }),
        ),
    );
  }
}
