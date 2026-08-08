import { trajectoryReadableBy, trajectorySegmentsWire } from "@everdict/application-control";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, fail, ok, run } from "../mcp-context.js";

// The owned trajectory ledger over MCP — BFF↔MCP parity with trajectory.routes.ts. Browse the sealed
// evidence (metas), then open one with get_trajectory.
export function registerTrajectoryTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.trajectoryStore) return;
  const store = deps.trajectoryStore;

  server.registerTool(
    "list_trajectories",
    {
      annotations: { readOnlyHint: true },
      description:
        "List the workspace's SEALED trajectories (the owned evidence ledger, newest first, cursor-paginated). " +
        "Each meta says how the evidence arrived (source: run | otlp | import), WHAT it is (kind: eval | " +
        "agent | command | sandbox | analysis, with a human label — the case id, the agent, the harness) and " +
        "how big it is (eventCount). Filter by kind to read just one family. Open one with get_trajectory.",
      inputSchema: {
        limit: z.number().int().positive().max(200).optional(),
        cursor: z.string().optional().describe("opaque cursor from the previous page"),
        kind: z.string().optional().describe("only this run family (eval | agent | command | sandbox | analysis)"),
      },
    },
    ({ limit, cursor, kind }: { limit?: number; cursor?: string; kind?: string }) =>
      run(principal, "runs:read", async () =>
        ok(
          await store.list(ws, {
            ...(limit !== undefined ? { limit } : {}),
            ...(cursor !== undefined ? { cursor } : {}),
            ...(kind !== undefined ? { kind } : {}),
            viewer: principal.subject, // personal evidence stays its owner's (BFF parity)
          }),
        ),
      ),
  );

  server.registerTool(
    "get_trajectory",
    {
      annotations: { readOnlyHint: true },
      description:
        "Open ONE sealed trajectory from the owned ledger: its meta plus every normalized TraceEvent (the " +
        "same evidence a judge reads). Keyed by the id it was sealed under (TrajectoryMeta.runId from " +
        "list_trajectories) — this works for every source, whereas get_run_trajectory only opens evidence " +
        "that has a run row (never an otlp arrival or a materialized import). `segments` lists every emitter " +
        "that contributed to the run — the execution plus each service:<service.name> that pushed its own " +
        "spans through the OTLP door — so you can read the whole SYSTEM (agent, placement, services), not " +
        "just the agent. The one segment without `events` is the execution one: its stream is `events`.",
      inputSchema: {
        runId: z.string().min(1).describe("the id the trajectory was sealed under (TrajectoryMeta.runId)"),
      },
    },
    ({ runId }: { runId: string }) =>
      run(principal, "runs:read", async () => {
        const sealed = await store.get(ws, runId);
        if (!sealed || !trajectoryReadableBy(sealed.meta, principal.subject))
          return fail("NOT_FOUND: trajectory not found.");
        const { tenant: _tenant, ...meta } = sealed.meta;
        return ok({ meta, events: sealed.events, segments: trajectorySegmentsWire(sealed) });
      }),
  );

  // Trace thresholds (E4 perception config) — BFF↔MCP parity with the /workspace/trace-thresholds routes.
  const settings = deps.settingsStore;
  if (!settings) return;

  server.registerTool(
    "get_workspace_trace_thresholds",
    {
      annotations: { readOnlyHint: true },
      description:
        "The tenant-configured trace thresholds — evaluated over EVERY trajectory at seal time; a crossing " +
        "lands trace.threshold_crossed on the event log (the wake signal a triage agent subscribes to).",
      inputSchema: {},
    },
    () => run(principal, "runs:read", async () => ok({ thresholds: (await settings.get(ws))?.traceThresholds ?? [] })),
  );

  server.registerTool(
    "get_workspace_trace_ingestion",
    {
      annotations: { readOnlyHint: true },
      description:
        "The OTLP door's ingestion state (N3 admission lane): the effective events/hour bound (workspace " +
        "override > operator default > unlimited), the last hour's stored events, and the retention TTL when " +
        "set. Past the bound the door refuses at 429 and lands trace.ingestion_throttled on the event log.",
      inputSchema: {},
    },
    () =>
      run(principal, "runs:read", async () => {
        const override = (await settings.get(ws))?.traceIngestion?.maxEventsPerHour;
        const operatorDefault = deps.traceIngestionConfig?.defaultMaxEventsPerHour;
        const used = await store.ingestedSince(ws, new Date(Date.now() - 3_600_000).toISOString());
        return ok({
          maxEventsPerHour: override ?? operatorDefault,
          source: override !== undefined ? "workspace" : operatorDefault !== undefined ? "operator" : "unlimited",
          usedLastHour: used.events,
          ...(deps.traceIngestionConfig?.retentionDays !== undefined
            ? { retentionDays: deps.traceIngestionConfig.retentionDays }
            : {}),
        });
      }),
  );

  server.registerTool(
    "set_workspace_trace_ingestion",
    {
      annotations: { readOnlyHint: false },
      description:
        "Set (or clear with null) the workspace's OTLP-door quota override — events stored per rolling hour. " +
        "Admin (settings:write).",
      inputSchema: { maxEventsPerHour: z.number().int().positive().nullable() },
    },
    ({ maxEventsPerHour }: { maxEventsPerHour: number | null }) =>
      run(principal, "settings:write", async () => {
        await settings.set(ws, {
          traceIngestion: maxEventsPerHour === null ? {} : { maxEventsPerHour },
        });
        return ok({ maxEventsPerHour: maxEventsPerHour ?? undefined });
      }),
  );

  server.registerTool(
    "set_workspace_trace_thresholds",
    {
      annotations: { readOnlyHint: false },
      description:
        "Replace the workspace's trace thresholds (full replacement). metric: usd | total_tokens | llm_calls | " +
        "tool_calls | tool_failures | events | latency_ms_max; value is the exceeds-bound (strictly greater). " +
        "Applies to the next sealed trajectory. Admin (settings:write).",
      inputSchema: {
        thresholds: z
          .array(
            z.object({
              name: z.string().min(1).max(120),
              metric: z.enum([
                "usd",
                "total_tokens",
                "llm_calls",
                "tool_calls",
                "tool_failures",
                "events",
                "latency_ms_max",
              ]),
              value: z.number().nonnegative(),
            }),
          )
          .max(50),
      },
    },
    ({
      thresholds,
    }: {
      thresholds: Array<{
        name: string;
        metric: "usd" | "total_tokens" | "llm_calls" | "tool_calls" | "tool_failures" | "events" | "latency_ms_max";
        value: number;
      }>;
    }) =>
      run(principal, "settings:write", async () => {
        await settings.set(ws, { traceThresholds: thresholds });
        return ok({ thresholds });
      }),
  );
}
