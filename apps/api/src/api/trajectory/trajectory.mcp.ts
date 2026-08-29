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
        "agent | command | sandbox | analysis, with a human label — the case id, the agent, the harness), what it " +
        "was asked to do (preview: the member's message, the first tool call, the root span — the label repeats " +
        "across a producer's rows, the preview is what tells them apart) and how big it is (eventCount). " +
        "Filter by kind to read just one family. Open one with get_trajectory.",
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
        "Open ONE PAGE of one sealed trajectory from the owned ledger: its meta, its plane headers, and a " +
        "window of normalized TraceEvents (the same evidence a judge reads). Keyed by the id it was sealed " +
        "under (TrajectoryMeta.runId from list_trajectories) — this works for every source, whereas " +
        "get_run_trajectory only opens evidence that has a run row (never an otlp arrival or a materialized " +
        "import). `segments` lists every emitter that contributed — the execution plus each " +
        "service:<service.name> that pushed its own spans through the OTLP door — so you can read the whole " +
        "SYSTEM (agent, placement, services); the one flagged `execution: true` is the plane this response's " +
        "events came from, and any other is opened by passing its `emitter`. A long-horizon run's trace does " +
        "not fit in one answer and never did: when `nextAfter` comes back, pass it as `after` for the next " +
        "page, and keep going until it is absent.",
      inputSchema: {
        runId: z.string().min(1).describe("the id the trajectory was sealed under (TrajectoryMeta.runId)"),
        emitter: z.string().optional().describe("which plane to read; default = the execution's own"),
        after: z.number().int().nonnegative().optional().describe("resume after this seq (from nextAfter)"),
        limit: z.number().int().positive().optional().describe("events per page (clamped by the store)"),
        // BFF parity with `GET /trajectories/:id?resolve=true` — one capability, two transports.
        resolve: z
          .boolean()
          .optional()
          .describe(
            "return the SEALED payload instead of the preview for events whose oversized field was moved to " +
              "object storage (they carry a `…Ref`). Off by default because it costs one fetch per moved " +
              "field; pages are much smaller when on, so keep following `nextAfter`. Ask for it when you are " +
              "JUDGING or auditing the evidence — an excerpt is different evidence.",
          ),
      },
    },
    ({
      runId,
      emitter,
      after,
      limit,
      resolve,
    }: { runId: string; emitter?: string; after?: number; limit?: number; resolve?: boolean }) =>
      run(principal, "runs:read", async () => {
        const sealed = await store.planes(ws, runId);
        if (!sealed || !trajectoryReadableBy(sealed.meta, principal.subject))
          return fail("NOT_FOUND: trajectory not found.");
        const page = await store.events(ws, runId, {
          ...(emitter !== undefined ? { emitter } : {}),
          ...(after !== undefined ? { after } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(resolve === true ? { resolve: true } : {}),
        });
        const { tenant: _tenant, ...meta } = sealed.meta;
        if (page.kind === "too_large")
          // Never an empty page: an agent told "0 events" would conclude the run did nothing and act on it.
          return fail(
            `CONFLICT: trajectory '${runId}' plane '${page.emitter}' is a ${page.storedBytes}-byte body sealed before it was split into events, over the ${page.limitBytes}-byte read ceiling. An operator splits it with scripts/live/split-trajectory-bodies.mjs.`,
          );
        const events = page.kind === "page" ? page.page.events : [];
        return ok({
          meta,
          events,
          segments: trajectorySegmentsWire(sealed),
          ...(page.kind === "page" && page.page.nextAfter !== undefined ? { nextAfter: page.page.nextAfter } : {}),
        });
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
