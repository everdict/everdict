import { EvalCaseSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, fail, ok, run } from "../mcp-context.js";

// Run resource MCP tools — the MCP twin of run.routes.ts (same RunService core, second transport).
export function registerRunTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  server.registerTool(
    "list_runs",
    {
      description:
        "This workspace's run list (standalone activity). With scorecard_id, the case child-runs of that scorecard. " +
        'With scope="all", standalone runs AND scorecard child runs together (the "all executions" view).',
      inputSchema: { scorecard_id: z.string().optional(), scope: z.enum(["standalone", "all"]).optional() },
    },
    ({ scorecard_id, scope }) =>
      run(principal, "runs:read", async () =>
        ok(
          await deps.service.list(
            ws,
            scorecard_id ? { scorecardId: scorecard_id } : scope === "all" ? { includeChildren: true } : undefined,
          ),
        ),
      ),
  );

  server.registerTool(
    "get_run",
    { description: "Fetch one run (another workspace's is NOT_FOUND)", inputSchema: { id: z.string() } },
    ({ id }) =>
      run(principal, "runs:read", async () => {
        const record = await deps.service.get(id);
        if (!record || record.tenant !== ws) return fail("NOT_FOUND: run not found.");
        return ok(record);
      }),
  );

  server.registerTool(
    "exec_in_run",
    {
      description:
        "Run a one-shot shell command inside a run's live sandbox container (web-terminal exec). Creator-or-admin only; found=false = no live container",
      inputSchema: { id: z.string(), command: z.string() },
    },
    ({ id, command }) =>
      run(principal, "runs:read", async () => {
        const out = await deps.service.exec(id, command);
        if (!out || out.record.tenant !== ws) return fail("NOT_FOUND: run not found.");
        if (out.record.createdBy && out.record.createdBy !== principal.subject && !principal.roles.includes("admin"))
          return fail("FORBIDDEN: only the run's creator or an admin can exec.");
        if (!out.result) return ok({ found: false, stdout: "", stderr: "", exitCode: null });
        return ok({ found: true, ...out.result });
      }),
  );

  server.registerTool(
    "get_run_logs",
    {
      description:
        "Current raw output of a run's job (live progress — poll while running; sentinel-stripped). stream: stdout (default, the result stream) | stderr (harness progress logs). found=false = nothing to tail yet",
      inputSchema: { id: z.string(), stream: z.enum(["stdout", "stderr"]).optional() },
    },
    ({ id, stream }) =>
      run(principal, "runs:read", async () => {
        const out = await deps.service.logs(id, stream);
        if (!out || out.record.tenant !== ws) return fail("NOT_FOUND: run not found.");
        return ok({ status: out.record.status, found: out.text !== undefined, text: out.text ?? "" });
      }),
  );

  server.registerTool(
    "submit_run",
    {
      description:
        "Submit an eval run (empty repo seed + default graders). harness is id@version (default latest). With runtime, run on that runtime.",
      inputSchema: {
        harness_id: z.string(),
        version: z.string().optional(),
        task: z.string(),
        runtime: z.string().optional(), // tenant Runtime id to run on (placement.target). If absent, the default backend.
        timeout_sec: z.number().int().positive().optional(),
      },
    },
    ({ harness_id, version, task, runtime, timeout_sec }) =>
      run(principal, "runs:submit", async () => {
        const evalCase = EvalCaseSchema.parse({
          id: `mcp-${Date.now().toString(36)}`,
          env: { kind: "repo", source: { files: {} } },
          task,
          graders: [{ id: "steps" }, { id: "cost" }, { id: "latency" }],
          timeoutSec: timeout_sec ?? 300,
          tags: ["mcp"],
        });
        const rec = await deps.service.submit({
          tenant: ws,
          submittedBy: principal.subject, // clone the private-repo seed via my personal connection
          harness: { id: harness_id, version: version ?? "latest" },
          case: evalCase,
          trigger: "mcp", // activity-view source axis — submitted by the agent over MCP
          ...(runtime ? { runtime } : {}),
        });
        return ok(rec);
      }),
  );
}
