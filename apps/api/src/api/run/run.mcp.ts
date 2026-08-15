import { EvalCaseSchema, type RunRecord } from "@everdict/contracts";
import { canReadRun } from "@everdict/domain";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { teamCeiling } from "../../common/team-scope.js";
import { type McpToolContext, fail, ok, run } from "../mcp-context.js";
import { serveBatchChildren } from "./serve.js";

// Run resource MCP tools — the MCP twin of run.routes.ts (same RunService core, second transport).
export function registerRunTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws, agent } = ctx;

  // Workspace scope + the audience rule in one question — the MCP twin of route-context's `runVisible` (a tool
  // file cannot import that module without closing a cycle, so both call the same domain rule). Another
  // workspace's run and another member's agent turn / shell session answer the same NOT_FOUND.
  const visible = (record: Pick<RunRecord, "tenant" | "kind" | "createdBy" | "origin">): boolean =>
    record.tenant === ws && canReadRun(record, principal.subject);

  server.registerTool(
    "get_run_trajectory",
    {
      annotations: { readOnlyHint: true },
      description:
        "A run's OWNED trajectory (the sealed copy every judgment stands on — P5): meta.source tells which " +
        "copy served (run | otlp | import | embed) plus the normalized TraceEvent[]. Falls back to the run " +
        "row's embed during the dual-read window.",
      inputSchema: { id: z.string().describe("run id") },
    },
    ({ id }: { id: string }) =>
      run(principal, "runs:read", async () => {
        const trajectory = await deps.service.trajectory(ws, id, principal.subject);
        if (!trajectory) return fail("NOT_FOUND: trajectory not found.");
        return ok(trajectory);
      }),
  );

  server.registerTool(
    "list_runs",
    {
      annotations: { readOnlyHint: true },
      description:
        "This workspace's run list (standalone activity). With scorecard_id, the case child-runs of that scorecard — " +
        "each row carries `canonical`: true = the attempt that batch's commit receipt named as its case's answer, " +
        "false = a superseded attempt of a receipted case, absent = unknown (no receipt). Read a superseded row's " +
        "trace as history, never as the batch's evidence. " +
        'With scope="all", standalone runs AND scorecard child runs together (the "all executions" view). With runner, ' +
        "the runs a self-hosted runner executed (newest first, capped by limit, offset-paginated) — the runner-detail activity feed.",
      inputSchema: {
        scorecard_id: z.string().optional(),
        scope: z.enum(["standalone", "all"]).optional(),
        runner: z.string().optional(),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    ({ scorecard_id, scope, runner, limit, offset }) =>
      run(principal, "runs:read", async () => {
        const runs = await deps.service.list(ws, {
          // The viewer keeps another member's agent turns and shell sessions off this page (BFF parity), and
          // the team ceiling keeps a private team's runs off it (same parity).
          viewer: principal.subject,
          ...(await teamCeiling(ctx.deps, principal)),
          ...(scorecard_id
            ? { scorecardId: scorecard_id }
            : runner
              ? { runnerId: runner, ...(limit ? { limit } : {}), ...(offset ? { offset } : {}) }
              : scope === "all"
                ? { includeChildren: true }
                : {}),
        });
        // BFF parity — the agent sees the same superseded/canonical labelling the screen does.
        if (!scorecard_id || !deps.scorecardService) return ok(runs);
        return ok(serveBatchChildren(runs, await deps.scorecardService.canonicalCaseRuns(scorecard_id, runs)));
      }),
  );

  server.registerTool(
    "get_run",
    {
      annotations: { readOnlyHint: true },
      description: "Fetch one run (another workspace's is NOT_FOUND)",
      inputSchema: { id: z.string() },
    },
    ({ id }) =>
      run(principal, "runs:read", async () => {
        const record = await deps.service.getForDisplay(id, principal.subject); // BFF parity — openable refs + the same audience rule
        if (!record || !visible(record)) return fail("NOT_FOUND: run not found.");
        return ok(record);
      }),
  );

  server.registerTool(
    "exec_in_run",
    {
      // NOT a read: executes a shell command in the run's live container. The authz action (:read) says who may CALL, never what it DOES.
      annotations: { readOnlyHint: false },
      description:
        "Run a one-shot shell command inside a run's live sandbox container (web-terminal exec). Creator-or-admin only; found=false = no live container",
      inputSchema: { id: z.string(), command: z.string() },
    },
    ({ id, command }) =>
      run(principal, "runs:read", async () => {
        const out = await deps.service.exec(id, command);
        if (!out || !visible(out.record)) return fail("NOT_FOUND: run not found.");
        if (out.record.createdBy && out.record.createdBy !== principal.subject && !principal.roles.includes("admin"))
          return fail("FORBIDDEN: only the run's creator or an admin can exec.");
        if (!out.result) return ok({ found: false, stdout: "", stderr: "", exitCode: null });
        return ok({ found: true, ...out.result });
      }),
  );

  server.registerTool(
    "get_run_logs",
    {
      annotations: { readOnlyHint: true },
      description:
        "Current raw output of a run's job (live progress — poll while running; sentinel-stripped). stream: stdout (default, the result stream) | stderr (harness progress logs). found=false = nothing to tail yet",
      inputSchema: { id: z.string(), stream: z.enum(["stdout", "stderr"]).optional() },
    },
    ({ id, stream }) =>
      run(principal, "runs:read", async () => {
        const out = await deps.service.logs(id, stream);
        if (!out || !visible(out.record)) return fail("NOT_FOUND: run not found.");
        return ok({ status: out.record.status, found: out.text !== undefined, text: out.text ?? "" });
      }),
  );

  server.registerTool(
    "get_run_live_trace",
    {
      annotations: { readOnlyHint: true },
      description:
        "The run's own TraceEvents accumulating while it runs (live trajectory — poll while running, each read " +
        "returns everything collected so far): dispatch placement marks, runner-pushed batches, and the managed " +
        "job's event-sentinel lines. A preview of the evidence get_run_trajectory serves once sealed. " +
        "found=false = nothing has arrived yet",
      inputSchema: { id: z.string().describe("run id") },
    },
    ({ id }: { id: string }) =>
      run(principal, "runs:read", async () => {
        const out = await deps.service.liveTrace(id);
        if (!out || !visible(out.record)) return fail("NOT_FOUND: run not found.");
        return ok({ status: out.record.status, found: out.events.length > 0, events: out.events });
      }),
  );

  server.registerTool(
    "get_run_screen",
    {
      annotations: { readOnlyHint: true },
      description:
        "The current screen of a run's environment as a PNG data URL — the browser the agent is driving or its " +
        "desktop, captured live (poll while running; a settled run has no screen). Use it to SEE what the agent is " +
        "doing when the trace alone is ambiguous. Creator-or-admin only. supported=false = this run has no screen " +
        "we can reach; found=false = supported but no frame captured yet",
      inputSchema: { id: z.string().describe("run id") },
    },
    ({ id }: { id: string }) =>
      run(principal, "runs:read", async () => {
        const out = await deps.service.screen(id);
        if (!out || !visible(out.record)) return fail("NOT_FOUND: run not found.");
        if (out.record.createdBy && out.record.createdBy !== principal.subject && !principal.roles.includes("admin"))
          return fail("FORBIDDEN: only the run's creator or an admin can view the screen.");
        return ok({
          status: out.record.status,
          supported: out.supported,
          found: out.dataUrl !== undefined,
          dataUrl: out.dataUrl ?? "",
        });
      }),
  );

  server.registerTool(
    "get_run_files",
    {
      annotations: { readOnlyHint: true },
      description:
        "List the live repo file tree of a running case's sandbox (tracked + untracked files, each with its " +
        "working-tree status vs HEAD: modified | added | deleted). The explorer half of the run workbench — use " +
        "it to see WHAT the agent has touched so far. Creator-or-admin only. found=false = no live container, " +
        "or the sandbox has no git worktree (non-repo env kinds)",
      inputSchema: { id: z.string().describe("run id") },
    },
    ({ id }: { id: string }) =>
      run(principal, "runs:read", async () => {
        const out = await deps.service.fsTree(id);
        if (!out || !visible(out.record)) return fail("NOT_FOUND: run not found.");
        if (out.record.createdBy && out.record.createdBy !== principal.subject && !principal.roles.includes("admin"))
          return fail("FORBIDDEN: only the run's creator or an admin can browse the sandbox files.");
        return ok({
          status: out.record.status,
          found: out.tree !== undefined,
          files: out.tree?.files ?? [],
          truncated: out.tree?.truncated ?? false,
        });
      }),
  );

  server.registerTool(
    "get_run_file",
    {
      annotations: { readOnlyHint: true },
      description:
        "Read one file of a running case's live repo, with its working-tree diff vs HEAD riding along — the " +
        "editor half of the run workbench. Reads are capped (truncated=true past the cap); a binary file " +
        "reports binary=true with empty content. Creator-or-admin only. found=false = no live container / not " +
        "a git worktree / no such file",
      inputSchema: {
        id: z.string().describe("run id"),
        path: z.string().describe("repo-relative file path (no leading slash, no traversal)"),
      },
    },
    ({ id, path }: { id: string; path: string }) =>
      run(principal, "runs:read", async () => {
        // Path format is validated by the service (BadRequestError → the run wrapper's fail envelope).
        const out = await deps.service.fsFile(id, path);
        if (!out || !visible(out.record)) return fail("NOT_FOUND: run not found.");
        if (out.record.createdBy && out.record.createdBy !== principal.subject && !principal.roles.includes("admin"))
          return fail("FORBIDDEN: only the run's creator or an admin can read the sandbox files.");
        return ok({
          status: out.record.status,
          found: out.file !== undefined,
          path,
          size: out.file?.size ?? 0,
          binary: out.file?.binary ?? false,
          truncated: out.file?.truncated ?? false,
          content: out.file?.content ?? "",
          diff: out.file?.diff ?? "",
        });
      }),
  );

  server.registerTool(
    "get_run_placement",
    {
      annotations: { readOnlyHint: true },
      description:
        "Where a run's case job stands INSIDE its runtime cluster (runtime debugging): phase " +
        "queued | blocked | starting | running | dead, the placed node/unit, the scheduler's capacity verdict when " +
        "blocked (Nomad exhausted dimensions / K8s FailedScheduling), and the orchestrator event feed (image pulls, " +
        "OOM kills, restarts). Use it to tell 'the cluster cannot place this' from 'placed but failing'. " +
        "found=false = nothing to describe (pre-dispatch / GC'd / unsupported backend)",
      inputSchema: { id: z.string().describe("run id") },
    },
    ({ id }: { id: string }) =>
      run(principal, "runs:read", async () => {
        const out = await deps.service.placement(id);
        if (!out || !visible(out.record)) return fail("NOT_FOUND: run not found.");
        return ok({ status: out.record.status, found: out.placement !== undefined, placement: out.placement ?? null });
      }),
  );

  server.registerTool(
    "get_run_topology",
    {
      annotations: { readOnlyHint: true },
      description:
        "The live per-service health roster of the warm topology a service-harness run drives (runtime " +
        "debugging): per service the orchestrator state, readiness, restart churn, OOM verdicts, and the last " +
        "notable event. Answers 'the case was placed, but is the SERVICE stack actually up'. found=false = not a " +
        "service harness / no topology runtime behind the lane",
      inputSchema: { id: z.string().describe("run id") },
    },
    ({ id }: { id: string }) =>
      run(principal, "runs:read", async () => {
        const out = await deps.service.topology(id);
        if (!out || !visible(out.record)) return fail("NOT_FOUND: run not found.");
        return ok({ status: out.record.status, found: out.topology !== undefined, topology: out.topology ?? null });
      }),
  );

  server.registerTool(
    "get_topology_service_logs",
    {
      annotations: { readOnlyHint: true },
      description:
        "Current log tail of ONE deployed service of a run's warm topology — the service-level twin of " +
        "get_run_logs ('the stack is up but the case fails: what is the service saying'). found=false = no live " +
        "unit for that service",
      inputSchema: {
        id: z.string().describe("run id"),
        service: z.string().describe("declared service name (see get_run_topology)"),
      },
    },
    ({ id, service }: { id: string; service: string }) =>
      run(principal, "runs:read", async () => {
        const out = await deps.service.topologyServiceLogs(id, service);
        if (!out || !visible(out.record)) return fail("NOT_FOUND: run not found.");
        return ok({ found: out.text !== undefined, text: out.text ?? "" });
      }),
  );

  server.registerTool(
    "get_run_recording",
    {
      annotations: { readOnlyHint: true },
      description:
        "The replay recording of a run — screen frames + logs + env/runtime tracks on one t0 clock, aligned with " +
        "the trace. A settled run answers its sealed recording; a still-running one answers the live tail so far " +
        "(envKind 'live' — poll while running). found=false when nothing was recorded. Creator-or-admin (it contains screenshots).",
      inputSchema: { id: z.string() },
    },
    ({ id }) =>
      run(principal, "runs:read", async () => {
        const out = await deps.service.recording(id);
        if (!out || !visible(out.record)) return fail("NOT_FOUND: run not found.");
        if (out.record.createdBy && out.record.createdBy !== principal.subject && !principal.roles.includes("admin"))
          return fail("FORBIDDEN: only the run's creator or an admin can view the recording.");
        return ok({ status: out.record.status, found: out.recording !== undefined, recording: out.recording ?? null });
      }),
  );

  server.registerTool(
    "submit_run",
    {
      annotations: { readOnlyHint: false },
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
          // P3 causedBy: an agent-driven session's submits are that run's downstream demand.
          ...(agent?.runId !== undefined ? { causedByRunId: agent.runId } : {}),
          ...(runtime ? { runtime } : {}),
        });
        return ok(rec);
      }),
  );
}
