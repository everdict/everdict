import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";
import type { UpdateScheduleInput } from "./schedule-service.js";

// Schedule resource MCP tools — the MCP twin of schedule.routes.ts (same ScheduleService core, second transport).
export function registerScheduleTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.scheduleService) {
    const schedules = deps.scheduleService;
    server.registerTool(
      "create_schedule",
      {
        description:
          "Create a scheduled (cron) scorecard — periodically run dataset×harness on a cron (regression tracking). Fired runs execute under my identity (budget→workspace). cron is 5 fields (min hour day month weekday).",
        inputSchema: {
          name: z.string(),
          cron: z.string().describe("5-field cron (e.g. '0 3 * * *' = daily at 03:00)"),
          timezone: z.string().optional().describe("IANA tz (default UTC)"),
          overlap_policy: z
            .enum(["skip", "bufferOne", "allowAll"])
            .optional()
            .describe("overlap policy (default skip)"),
          enabled: z.boolean().optional(),
          dataset_id: z.string(),
          dataset_version: z.string().optional(),
          harness_id: z.string(),
          harness_version: z.string().optional(),
          judges: z.array(z.object({ id: z.string(), version: z.string().optional() })).optional(),
          runtime: z.string().optional(),
          concurrency: z.number().int().min(1).max(64).optional(),
        },
      },
      (a) =>
        run(principal, "schedules:write", async () =>
          ok(
            await schedules.create({
              tenant: ws,
              createdBy: principal.subject,
              name: a.name,
              cron: a.cron,
              ...(a.timezone !== undefined ? { timezone: a.timezone } : {}),
              ...(a.overlap_policy !== undefined ? { overlapPolicy: a.overlap_policy } : {}),
              ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
              runTemplate: {
                dataset: { id: a.dataset_id, version: a.dataset_version ?? "latest" },
                harness: { id: a.harness_id, version: a.harness_version ?? "latest" },
                judges: (a.judges ?? []).map((j) => ({ id: j.id, version: j.version ?? "latest" })),
                ...(a.runtime !== undefined ? { runtime: a.runtime } : {}),
                ...(a.concurrency !== undefined ? { concurrency: a.concurrency } : {}),
              },
            }),
          ),
        ),
    );

    server.registerTool(
      "list_schedules",
      { description: "This workspace's scheduled scorecards", inputSchema: {} },
      () => run(principal, "schedules:read", async () => ok(await schedules.list(ws))),
    );

    server.registerTool(
      "get_schedule",
      { description: "Read one schedule (other workspaces get NOT_FOUND)", inputSchema: { id: z.string() } },
      ({ id }) => run(principal, "schedules:read", async () => ok(await schedules.get(ws, id))),
    );

    server.registerTool(
      "update_schedule",
      {
        description:
          "Update a schedule — pause/resume (enabled), reschedule (cron/timezone), change name/overlap policy. Swap runTemplate (dataset·harness) via the BFF or by recreating.",
        inputSchema: {
          id: z.string(),
          name: z.string().optional(),
          cron: z.string().optional(),
          timezone: z.string().optional(),
          overlap_policy: z.enum(["skip", "bufferOne", "allowAll"]).optional(),
          enabled: z.boolean().optional(),
        },
      },
      (a) =>
        run(principal, "schedules:write", async () => {
          const patch: UpdateScheduleInput = {};
          if (a.name !== undefined) patch.name = a.name;
          if (a.cron !== undefined) patch.cron = a.cron;
          if (a.timezone !== undefined) patch.timezone = a.timezone;
          if (a.overlap_policy !== undefined) patch.overlapPolicy = a.overlap_policy;
          if (a.enabled !== undefined) patch.enabled = a.enabled;
          return ok(
            await schedules.update(ws, a.id, patch, {
              subject: principal.subject,
              isAdmin: principal.roles.includes("admin"),
            }),
          );
        }),
    );

    server.registerTool(
      "delete_schedule",
      { description: "Delete a schedule (other workspaces get NOT_FOUND)", inputSchema: { id: z.string() } },
      ({ id }) =>
        run(principal, "schedules:write", async () => {
          await schedules.remove(ws, id);
          return ok({ id, deleted: true });
        }),
    );
  }
}
