import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Trace-sink MCP tools — the MCP twin of trace-sink.routes.ts.
export function registerTraceSinkTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  // Workspace trace sinks (multiple) — export judged scorecard detail to the team's observability platform. Register multiple sinks by
  // name and select 'per harness'. Read harnesses:read / register·remove settings:write / select harnesses:register.
  // Design: docs/architecture/trace-sink.md
  if (deps.traceSinkService) {
    const sink = deps.traceSinkService;
    server.registerTool(
      "list_workspace_trace_sinks",
      {
        description:
          "This workspace's trace sinks + per-harness selection state — {sinks:[{name,kind,endpoint,…}], assignments:{harnessId→sinkName}} (not secret values).",
        inputSchema: {},
      },
      () => run(principal, "harnesses:read", async () => ok(await sink.list(ws))),
    );
    server.registerTool(
      "set_workspace_trace_sink",
      {
        description:
          "Register/update a trace sink (admin, upsert by name). When a harness selects this sink, per-case trace+scores are exported to this platform on scorecard completion. Put the auth token (value) in the SecretStore first and pass its name as authSecretName.",
        inputSchema: {
          name: z.string().min(1).describe("sink name (reference key — per-harness selection points at this name)"),
          kind: z.enum(["mlflow", "langfuse", "langsmith", "phoenix"]).describe("observability platform kind"),
          endpoint: z.string().url().describe("platform API base URL"),
          authSecretName: z
            .string()
            .min(1)
            .optional()
            .describe("SecretStore key name holding the auth-header 'value' (omit for an unauthenticated dev server)"),
          project: z
            .string()
            .min(1)
            .optional()
            .describe(
              "per-kind project coordinate — mlflow experiment_id · langsmith project · phoenix project · langfuse projectId",
            ),
          webUrl: z.string().url().optional().describe("UI deep-link base (when it differs from the API endpoint)"),
        },
      },
      (input) => run(principal, "settings:write", async () => ok({ config: await sink.upsert(ws, input) })),
    );
    server.registerTool(
      "remove_workspace_trace_sink",
      {
        description:
          "Remove a trace sink (admin, by name). Any per-harness selection pointing at it is cleaned up too.",
        inputSchema: { name: z.string().min(1).describe("name of the sink to remove") },
      },
      ({ name }) =>
        run(principal, "settings:write", async () => {
          await sink.remove(ws, name);
          return ok({ ok: true });
        }),
    );
    server.registerTool(
      "assign_harness_trace_sink",
      {
        description:
          "Per-harness trace sink selection (member+) — which sink to export to when that harness's scorecard completes. Omit sink to clear the selection (export off).",
        inputSchema: {
          harness: z.string().min(1).describe("harness id"),
          sink: z.string().min(1).optional().describe("sink name (omit = clear selection)"),
        },
      },
      ({ harness, sink: sinkName }) =>
        run(principal, "harnesses:register", async () =>
          ok({ assignments: await sink.assign(ws, harness, sinkName ?? null) }),
        ),
    );
  }
}
