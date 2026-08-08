import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";
import { serveScorecard } from "../scorecard/serve.js";

// Run-group MCP tools — the MCP twin of group.routes.ts (same ScorecardService core, second transport).
// Reading a group is get_scorecard (a group IS a scorecard row; kind tells them apart).
export function registerGroupTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws, agent } = ctx;
  if (!deps.scorecardService) return;
  const scorecards = deps.scorecardService;

  server.registerTool(
    "run_experiment",
    {
      annotations: { readOnlyHint: false },
      description:
        "Run an ungraded EXPERIMENT (phase 1 alone): drive a harness over a dataset (graders stripped) or a " +
        "one-off task prompt, N times via trials — no judges, no verdict; the child runs and their " +
        "trajectories are the product. Async: returns the queued group record (kind experiment); poll with " +
        "get_scorecard. Exactly one of dataset_id or task_prompt is required.",
      inputSchema: {
        harness_id: z.string(),
        harness_version: z.string().optional(),
        dataset_id: z.string().optional().describe("registered dataset to drive (graders stripped for this group)"),
        dataset_version: z.string().optional(),
        task_prompt: z.string().optional().describe("one-off ad-hoc task instead of a dataset"),
        task_timeout_sec: z.number().int().min(30).max(14_400).optional(),
        trials: z.number().int().min(1).max(100).optional().describe("run the task/cases N times (default 1)"),
        runtime: z
          .string()
          .optional()
          .describe("tenant Runtime id (placement.target) or self runner target. If absent, 400 per deployment policy"),
        concurrency: z.number().int().min(1).max(512).optional(),
      },
    },
    ({
      harness_id,
      harness_version,
      dataset_id,
      dataset_version,
      task_prompt,
      task_timeout_sec,
      trials,
      runtime,
      concurrency,
    }) =>
      run(principal, "scorecards:run", async () =>
        ok(
          serveScorecard(
            await scorecards.submitExperiment({
              tenant: ws,
              submittedBy: principal.subject,
              harness: { id: harness_id, version: harness_version ?? "latest" },
              ...(dataset_id ? { dataset: { id: dataset_id, version: dataset_version ?? "latest" } } : {}),
              ...(task_prompt
                ? {
                    task: {
                      prompt: task_prompt,
                      ...(task_timeout_sec !== undefined ? { timeoutSec: task_timeout_sec } : {}),
                    },
                  }
                : {}),
              ...(trials !== undefined ? { trials } : {}),
              ...(runtime ? { runtime } : {}),
              ...(concurrency !== undefined ? { concurrency } : {}),
              origin: { source: "mcp", ...(agent?.runId !== undefined ? { causedByRunId: agent.runId } : {}) },
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "score_group",
    {
      annotations: { readOnlyHint: false },
      description:
        "Score an existing group's runs with the selected judges (phase 2, detached): judge verdicts attach " +
        "to the child runs, the fresh aggregate to the group. Re-scoring a judge replaces its previous " +
        "verdicts; scoring an EXPERIMENT promotes it to a scorecard. Async — returns the record as-of " +
        "submission; poll get_scorecard until summary/judgeModels move.",
      inputSchema: {
        id: z.string().describe("group id (a scorecard id)"),
        judges: z
          .array(z.object({ id: z.string(), version: z.string().optional() }))
          .min(1)
          .describe("Agent Judges to apply (version defaults to latest)"),
      },
    },
    ({ id, judges }: { id: string; judges: Array<{ id: string; version?: string }> }) =>
      run(principal, "scorecards:run", async () =>
        ok(
          serveScorecard(
            await scorecards.scoreGroup({
              tenant: ws,
              id,
              judges: judges.map((j) => ({ id: j.id, version: j.version ?? "latest" })),
              submittedBy: principal.subject,
            }),
          ),
        ),
      ),
  );
}
