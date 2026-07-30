import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Sandbox session runs over MCP — BFF↔MCP parity with sandbox.routes.ts (same service, same authz: the
// role gate here, creator-or-admin inside the service). An agent bringing an environment up to look inside
// is the environment store's authoring loop: verify_image proves it pulls, a sandbox proves it RUNS.
export function registerSandboxTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.sandboxSessions) return;
  const sessions = deps.sandboxSessions;
  const actor = () => ({ tenant: ws, subject: principal.subject, isAdmin: principal.roles.includes("admin") });

  server.registerTool(
    "create_sandbox",
    {
      description:
        "Open a sandbox session: boot an environment image as a long-lived container (shell in), or boot a " +
        "registered HARNESS for interactive test cases (the playground — warm-installed once, then " +
        "submit_sandbox_task drives it). Recorded as a Run (kind sandbox, lifetime session) with a hard TTL; " +
        "every exec lands on its trajectory, sealed at close. Exactly one of image (ad-hoc pullable ref), " +
        "environment (an adopted environment capability), or harness is required.",
      inputSchema: {
        image: z.string().optional().describe("Ad-hoc container image ref (must be pullable)"),
        environment: z
          .object({
            source: z.string().optional(),
            id: z.string(),
            version: z.string().optional(),
          })
          .optional()
          .describe("An adopted environment capability to boot (resolved through the consume gate)"),
        harness: z
          .object({
            id: z.string(),
            version: z.string().optional(),
            image: z.string().optional(),
          })
          .optional()
          .describe(
            "A registered harness to boot for test cases; image is required when the spec declares none (process kind)",
          ),
        ttlSec: z.number().int().positive().max(14400).optional().describe("Session TTL (default 900s)"),
      },
    },
    ({
      image,
      environment,
      harness,
      ttlSec,
    }: {
      image?: string;
      environment?: { source?: string; id: string; version?: string };
      harness?: { id: string; version?: string; image?: string };
      ttlSec?: number;
    }) =>
      run(principal, "runs:submit", async () =>
        ok(
          await sessions.create({
            tenant: ws,
            createdBy: principal.subject,
            ...(image !== undefined ? { image } : {}),
            ...(environment !== undefined ? { environment } : {}),
            ...(harness !== undefined ? { harness } : {}),
            ...(ttlSec !== undefined ? { ttlSec } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_sandboxes",
    {
      description:
        "List live sandbox sessions for this workspace (record + live meta: expiresAt, busy, booted harness, " +
        "task summaries) — the reattach surface. Settled sessions stay on the runs ledger.",
      inputSchema: {},
    },
    () => run(principal, "runs:read", async () => ok({ sessions: await sessions.listSessions(actor()) })),
  );

  server.registerTool(
    "get_sandbox",
    {
      description:
        "Read one sandbox session: the ledger RunRecord (settled sessions included) plus live meta while this " +
        "control plane holds the container.",
      inputSchema: { id: z.string().describe("The sandbox session's run id") },
    },
    ({ id }: { id: string }) => run(principal, "runs:read", async () => ok(await sessions.getSession(actor(), id))),
  );

  server.registerTool(
    "submit_sandbox_task",
    {
      description:
        "Submit one ad-hoc test case into a live harness session (the playground): the session's harness runs " +
        "the task prompt in a fresh working directory of the warm container — no dataset, no graders. Returns " +
        "the child run (kind eval, grouped to the session) immediately; poll read_sandbox_task_trace for live " +
        "events. One task at a time per session (409 while busy). Creator-or-admin.",
      inputSchema: {
        id: z.string().describe("The sandbox session's run id"),
        task: z.string().describe("The test-case prompt for the harness"),
        timeoutSec: z.number().int().positive().max(3600).optional().describe("Per-case timeout (default 600s)"),
      },
    },
    ({ id, task, timeoutSec }: { id: string; task: string; timeoutSec?: number }) =>
      run(principal, "runs:submit", async () =>
        ok(await sessions.submitTask(actor(), id, { task, ...(timeoutSec !== undefined ? { timeoutSec } : {}) })),
      ),
  );

  server.registerTool(
    "read_sandbox_task_trace",
    {
      description:
        "Poll one test case's trace: events since a cursor into the task's append-only buffer (omit = full " +
        "replay). Live while the task runs — a streaming harness shows tool calls before the case finishes; " +
        "after settle the sealed trajectory serves the same events. done:true = stop polling.",
      inputSchema: {
        id: z.string().describe("The sandbox session's run id"),
        taskRunId: z.string().describe("The test case's child run id"),
        since: z.number().int().nonnegative().optional().describe("Cursor from the previous page (default 0)"),
      },
    },
    ({ id, taskRunId, since }: { id: string; taskRunId: string; since?: number }) =>
      run(principal, "runs:read", async () => ok(await sessions.readTaskTrace(actor(), id, taskRunId, since ?? 0))),
  );

  server.registerTool(
    "sandbox_exec",
    {
      description:
        "Run one shell command (`sh -c`) inside a live sandbox session and get stdout/stderr/exitCode. " +
        "Creator-or-admin only — checked before the command runs. The exec is appended to the session's trajectory.",
      inputSchema: {
        id: z.string().describe("The sandbox session's run id"),
        command: z.string(),
        timeoutSec: z.number().int().positive().max(600).optional(),
      },
    },
    ({ id, command, timeoutSec }: { id: string; command: string; timeoutSec?: number }) =>
      run(principal, "runs:read", async () =>
        ok(await sessions.exec(actor(), id, { command, ...(timeoutSec !== undefined ? { timeoutSec } : {}) })),
      ),
  );

  server.registerTool(
    "close_sandbox",
    {
      description:
        "Close a sandbox session: tears the container down, seals the session trajectory, settles the run as " +
        "succeeded with session.closedReason. Idempotent over an already-settled session.",
      inputSchema: { id: z.string().describe("The sandbox session's run id") },
    },
    ({ id }: { id: string }) => run(principal, "runs:read", async () => ok(await sessions.close(actor(), id))),
  );
}
