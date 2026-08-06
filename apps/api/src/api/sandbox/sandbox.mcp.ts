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
  // The agent behind this MCP session, when the client declared one — every fact these tools emit then
  // carries `causedBy: agent:<id>:<conversation>`, which is the loop guard's key: an autonomous agent that
  // snapshots a world must never wake on its own snapshot (W3).
  const agent =
    ctx.agent?.agentId !== undefined
      ? {
          agentId: ctx.agent.agentId,
          ...(ctx.agent.conversationId !== undefined ? { conversationId: ctx.agent.conversationId } : {}),
          // The agent's CURRENT ledger run — the session draws from that turn's envelope and is counted by
          // the causal-depth guard (§5.1), instead of an agent loop opening sessions against nobody's budget.
          ...(ctx.agent.runId !== undefined ? { runId: ctx.agent.runId } : {}),
        }
      : undefined;
  const actor = () => ({
    tenant: ws,
    subject: principal.subject,
    isAdmin: principal.roles.includes("admin"),
    ...(agent !== undefined ? { agent } : {}),
  });

  server.registerTool(
    "create_sandbox",
    {
      description:
        "Open a sandbox session: boot an environment image as a long-lived container (shell in), boot a " +
        "registered HARNESS for interactive test cases (the playground — warm-installed once, then " +
        "submit_sandbox_task drives it), or open a WORLD — a persistent environment whose versions are " +
        "filesystem snapshots: world:{id} boots its latest snapshot (or founds it from `image` when it has " +
        "none yet), and snapshot_sandbox / hibernate-at-teardown publish the next version, so work survives " +
        "the container. Recorded as a Run (kind sandbox, lifetime session) with a hard TTL (touch_sandbox " +
        "extends it); every exec lands on its trajectory, sealed at close. Provide exactly one of image, " +
        "environment, or harness — or world (optionally with image as its genesis base).",
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
            conversation: z.boolean().optional(),
          })
          .optional()
          .describe(
            "A registered harness to boot for test cases; image is required when the spec declares none " +
              "(process kind). conversation:true boots a CONVERSATION session — each submitted task continues " +
              "one conversation (stable workdir + the harness's resume mechanism); 400 when the harness cannot resume",
          ),
        world: z
          .object({ id: z.string() })
          .optional()
          .describe(
            "Open as a world: boot the world's latest snapshot, or found it from `image`. The id doubles as " +
              "the snapshot repository name (lowercase letters, digits, '.', '_', '-')",
          ),
        hibernate: z
          .boolean()
          .optional()
          .describe("Auto-snapshot at teardown (default true for world sessions; ignored without world)"),
        repo: z
          .object({ git: z.string(), ref: z.string().optional(), dir: z.string().optional() })
          .optional()
          .describe(
            "Clone a repository into the session (default directory 'work'). A private repo needs the " +
              "workspace GitHub App installed on its owner; commit with sandbox_exec, publish with sandbox_git_push",
          ),
        runtime: z
          .string()
          .optional()
          .describe(
            "Place the session on a runtime this workspace registered (nomad); omit for the deployment's default compute",
          ),
        ttlSec: z.number().int().positive().max(14400).optional().describe("Session TTL (default 900s)"),
      },
    },
    ({
      image,
      environment,
      harness,
      world,
      hibernate,
      repo,
      runtime,
      ttlSec,
    }: {
      image?: string;
      environment?: { source?: string; id: string; version?: string };
      harness?: { id: string; version?: string; image?: string; conversation?: boolean };
      world?: { id: string };
      hibernate?: boolean;
      repo?: { git: string; ref?: string; dir?: string };
      runtime?: string;
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
            ...(world !== undefined ? { world } : {}),
            ...(hibernate !== undefined ? { hibernate } : {}),
            ...(repo !== undefined ? { repo } : {}),
            ...(agent !== undefined ? { agent } : {}),
            ...(runtime !== undefined ? { runtime } : {}),
            ...(ttlSec !== undefined ? { ttlSec } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "snapshot_sandbox",
    {
      description:
        "Publish a world session's filesystem as the world's next snapshot: commit the live container, push " +
        "it into the workspace's managed image namespace (next v<n> tag), and register a new " +
        "environment-capability version pinned to the pushed digest — the next create_sandbox world:{id} " +
        "boots from it. Prose (name/description/instructions) carries forward from the latest version when " +
        "omitted. Creator-or-admin; 409 while a playground task runs; 400 on a session with no world.",
      inputSchema: {
        id: z.string().describe("The sandbox session's run id"),
        name: z.string().optional().describe("World display name (default: carried forward)"),
        description: z.string().optional().describe("World description (default: carried forward)"),
        instructions: z
          .string()
          .optional()
          .describe("How the world is composed, for its next consumer (default: carried forward)"),
      },
    },
    ({
      id,
      name,
      description,
      instructions,
    }: { id: string; name?: string; description?: string; instructions?: string }) =>
      run(principal, "images:push", async () =>
        ok(
          await sessions.snapshot(actor(), id, {
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(instructions !== undefined ? { instructions } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "sandbox_git_push",
    {
      description:
        "Publish a session's work: push the checked-out branch to the repository it was cloned from, and " +
        "optionally open a pull request for it. COMMIT FIRST with sandbox_exec (git add/commit need no " +
        "credential) — this tool only authenticates the push, with a token minted for this one call and never " +
        "stored. The remote is read from the container, so what is pushed is what is actually checked out. " +
        "400 on a directory with no remote or a detached HEAD; 404 when no workspace GitHub App installation " +
        "covers the repository. Creator-or-admin.",
      inputSchema: {
        id: z.string().describe("The sandbox session's run id"),
        dir: z.string().optional().describe("Working directory (default: what the session cloned into)"),
        branch: z.string().optional().describe("Branch to push (default: the working tree's current branch)"),
        remote: z.string().optional().describe("Remote name (default: origin)"),
        pullRequest: z
          .object({ title: z.string(), body: z.string().optional() })
          .optional()
          .describe("Open a pull request for the pushed branch against the repository's default branch"),
      },
    },
    ({
      id,
      dir,
      branch,
      remote,
      pullRequest,
    }: {
      id: string;
      dir?: string;
      branch?: string;
      remote?: string;
      pullRequest?: { title: string; body?: string };
    }) =>
      run(principal, "github:write", async () =>
        ok(
          await sessions.gitPush(actor(), id, {
            ...(dir !== undefined ? { dir } : {}),
            ...(branch !== undefined ? { branch } : {}),
            ...(remote !== undefined ? { remote } : {}),
            ...(pullRequest !== undefined ? { pullRequest } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "touch_sandbox",
    {
      description:
        "Extend a live sandbox session's hard deadline to now+ttl (keep-alive; clamped to the max, never " +
        "shortens). Extends process memory, the run record, and the durable reaper's timer. Creator-or-admin.",
      inputSchema: {
        id: z.string().describe("The sandbox session's run id"),
        ttlSec: z.number().int().positive().max(14400).optional().describe("New TTL from now (default 900s)"),
      },
    },
    ({ id, ttlSec }: { id: string; ttlSec?: number }) =>
      run(principal, "runs:read", async () =>
        ok(await sessions.touch(actor(), id, { ...(ttlSec !== undefined ? { ttlSec } : {}) })),
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
        "the task prompt in a fresh working directory of the warm container — no dataset, no graders. On a " +
        "CONVERSATION session (created with harness.conversation) each submit is one more turn of the same " +
        "conversation instead. Returns the child run (kind eval, grouped to the session) immediately; poll " +
        "read_sandbox_task_trace for live events. One task at a time per session (409 while busy). Creator-or-admin.",
      inputSchema: {
        id: z.string().describe("The sandbox session's run id"),
        task: z.string().describe("The test-case prompt for the harness"),
        timeoutSec: z.number().int().positive().max(3600).optional().describe("Per-case timeout (default 600s)"),
        fresh: z
          .boolean()
          .optional()
          .describe("Conversation sessions only: start a new conversation thread (same workdir); 400 otherwise"),
      },
    },
    ({ id, task, timeoutSec, fresh }: { id: string; task: string; timeoutSec?: number; fresh?: boolean }) =>
      run(principal, "runs:submit", async () =>
        ok(
          await sessions.submitTask(actor(), id, {
            task,
            ...(timeoutSec !== undefined ? { timeoutSec } : {}),
            ...(fresh !== undefined ? { fresh } : {}),
          }),
        ),
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
        "succeeded with session.closedReason. A world session with hibernate on snapshots BEFORE the container " +
        "dies; `snapshot` overrides that default for this one close. Idempotent over an already-settled session.",
      inputSchema: {
        id: z.string().describe("The sandbox session's run id"),
        snapshot: z
          .boolean()
          .optional()
          .describe("Override the session's hibernate default: false = close without saving, true = force one"),
      },
    },
    ({ id, snapshot }: { id: string; snapshot?: boolean }) =>
      run(principal, "runs:read", async () =>
        ok(await sessions.close(actor(), id, { ...(snapshot !== undefined ? { snapshot } : {}) })),
      ),
  );
}
