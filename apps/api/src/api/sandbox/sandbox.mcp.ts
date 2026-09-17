import { type DelegateDeliveryMode, DelegateDeliveryModeSchema, DelegationBriefSchema } from "@everdict/contracts";
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
      annotations: { readOnlyHint: false },
      description:
        "Open a sandbox session: hand work to a DELEGATION PROFILE (profile:{id} + brief — a registered work " +
        "environment: its image, agent, model connection, env and standing instructions pinned once; always a " +
        "conversation, so keep talking to it with submit_sandbox_task), boot an environment image as a " +
        "long-lived container (shell in), boot a " +
        "registered HARNESS for interactive test cases (the playground — warm-installed once, then " +
        "submit_sandbox_task drives it), or open a WORLD — a persistent environment whose versions are " +
        "filesystem snapshots: world:{id} boots its latest snapshot (or founds it from `image` when it has " +
        "none yet), and snapshot_sandbox / hibernate-at-teardown publish the next version, so work survives " +
        "the container. Recorded as a Run (kind sandbox, lifetime session) with a hard TTL (touch_sandbox " +
        "extends it); every exec lands on its trajectory, sealed at close. Provide exactly one of image, " +
        "environment, or harness — or world (optionally with image as its genesis base).",
      inputSchema: {
        profile: z
          .object({ source: z.string().optional(), id: z.string(), version: z.string().optional() })
          .optional()
          .describe(
            "A DELEGATION PROFILE (a `delegation` capability) — WHO does the work: the registered environment " +
              "(its image, which conversational agent runs, the model connection, env/secrets and standing " +
              "instructions) pinned once. Always a conversation; pair it with `brief`. It is an OVERLAY, not a " +
              "boot mode: alone it runs in its own image, with `world` the delegate picks up that world (or " +
              "FOUNDS it from the profile's image), with `environment`/`image` it works in that one, and " +
              "`repo` clones in as usual. Only `harness` conflicts (that also says who runs)",
          ),
        campaign_id: z
          .string()
          .optional()
          .describe(
            "Use platform-authored target-only evidence and a scoped credential for this campaign; requires profile and excludes brief/world.",
          ),
        brief: z
          .object({
            goal: z.string(),
            context: z.string().optional(),
            references: z
              .array(
                z.object({
                  type: z.string(),
                  id: z.string(),
                  version: z.string().optional(),
                  note: z.string().optional(),
                }),
              )
              .optional(),
            constraints: z.array(z.string()).optional(),
            doneWhen: z.array(z.string()).optional(),
          })
          .optional()
          .describe(
            "The handoff: what must be true when this is done, the evidence you are handing over, what the " +
              "delegate must not do, and the checks you will apply. Written into the delegate's working " +
              "directory as BRIEF.md and sealed on the session's trajectory. Requires `profile`",
          ),
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
        identity: z
          .object({ source: z.string().optional(), id: z.string().min(1), version: z.string().optional() })
          .optional()
          .describe(
            "Run as a NAMED cli-identity capability instead of your own. Omit it and the session uses the identity " +
              "YOU registered for the CLI this profile runs — register once, never name it again. Two of your own for " +
              "one CLI is a refusal naming both, because choosing would sign the work with an account you did not pick",
          ),

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
      profile,
      campaign_id,
      brief,
      image,
      environment,
      harness,
      world,
      hibernate,
      repo,
      identity,
      runtime,
      ttlSec,
    }: {
      profile?: { source?: string; id: string; version?: string };
      campaign_id?: string;
      brief?: {
        goal: string;
        context?: string;
        references?: Array<{ type: string; id: string; version?: string; note?: string }>;
        constraints?: string[];
        doneWhen?: string[];
      };
      image?: string;
      environment?: { source?: string; id: string; version?: string };
      harness?: { id: string; version?: string; image?: string; conversation?: boolean };
      world?: { id: string };
      hibernate?: boolean;
      repo?: { git: string; ref?: string; dir?: string };
      identity?: { source?: string; id: string; version?: string };
      runtime?: string;
      ttlSec?: number;
    }) =>
      run(principal, "runs:submit", async () =>
        ok(
          await sessions.create({
            tenant: ws,
            createdBy: principal.subject,
            ...(campaign_id ? { campaignId: campaign_id } : {}),
            ...(profile !== undefined ? { profile } : {}),
            // The tool's loose reference shape is validated into the contract here — one parse, so a bad
            // reference kind is refused by name instead of reaching the delegate as a broken brief.
            ...(brief !== undefined ? { brief: DelegationBriefSchema.parse(brief) } : {}),
            ...(image !== undefined ? { image } : {}),
            ...(environment !== undefined ? { environment } : {}),
            ...(harness !== undefined ? { harness } : {}),
            ...(world !== undefined ? { world } : {}),
            ...(hibernate !== undefined ? { hibernate } : {}),
            ...(repo !== undefined ? { repo } : {}),
            ...(identity !== undefined ? { identity } : {}),
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
      annotations: { readOnlyHint: false },
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
      annotations: { readOnlyHint: false },
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
      // NOT a read: mutates the session's hard deadline (record + reaper timer). The authz action (:read) says who may CALL, never what it DOES.
      annotations: { readOnlyHint: false },
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
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: false },
      description:
        "Submit one ad-hoc test case into a live harness session (the playground): the session's harness runs " +
        "the task prompt in a fresh working directory of the warm container — no dataset, no graders. On a " +
        "CONVERSATION session (created with harness.conversation) each submit is one more turn of the same " +
        "conversation instead.\n\n" +
        "A BUSY DELEGATE IS NO LONGER A REFUSAL. `delivery` says what this does to the turn in flight:\n" +
        "  `message`   — queue it; starts no turn and disturbs none. Use it for context the delegate should " +
        "have but that does not deserve a derailment.\n" +
        "  `task`      — the default and what every caller meant before: start a turn if the delegate is idle, " +
        "otherwise queue it to start the moment the current turn ends.\n" +
        "  `interrupt` — abort the current turn, then start this one. The session, container and working " +
        "directory all survive; only the turn is stopped.\n\n" +
        "The answer says WHICH happened — `{delivered:'started', run}` or `{delivered:'queued', queued, " +
        "state}` — so you know whether there is a trace to poll. Queued messages are delivered together, in " +
        "order, ahead of the next turn's prompt. Creator-or-admin.",
      inputSchema: {
        id: z.string().describe("The sandbox session's run id"),
        task: z.string().describe("The test-case prompt for the harness"),
        timeoutSec: z.number().int().positive().max(3600).optional().describe("Per-case timeout (default 600s)"),
        fresh: z
          .boolean()
          .optional()
          .describe("Conversation sessions only: start a new conversation thread (same workdir); 400 otherwise"),
        delivery: DelegateDeliveryModeSchema.optional().describe(
          "message = queue without starting a turn · task (default) = start or queue · interrupt = stop the current turn first",
        ),
      },
    },
    ({
      id,
      task,
      timeoutSec,
      fresh,
      delivery,
    }: {
      id: string;
      task: string;
      timeoutSec?: number;
      fresh?: boolean;
      delivery?: DelegateDeliveryMode;
    }) =>
      run(principal, "runs:submit", async () =>
        ok(
          await sessions.submitTask(actor(), id, {
            task,
            ...(timeoutSec !== undefined ? { timeoutSec } : {}),
            ...(fresh !== undefined ? { fresh } : {}),
            ...(delivery !== undefined ? { delivery } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "interrupt_sandbox_task",
    {
      annotations: { readOnlyHint: false },
      description:
        "Stop the delegate's current turn and KEEP the session. The container, the working directory and the " +
        "conversation all survive, so the delegate can take the next instruction immediately — this is the " +
        "tool for 'you are solving the wrong problem', and it is not close_sandbox, which destroys the " +
        "container and every uncommitted change in it.\n\n" +
        "Returns the delegate's new state; `previous` names what was stopped. Interrupting something already " +
        "interrupted keeps the ORIGINAL `previous`, because that first record is the one that explains the " +
        "state the container was left in. Give a `reason` — it lands on the session's trajectory, and a " +
        "supervisor reading back six interrupts wants to know why each one happened.",
      inputSchema: {
        id: z.string().describe("The sandbox session's run id"),
        reason: z.string().max(1000).optional().describe("Why you are stopping it — recorded on the trajectory"),
      },
    },
    ({ id, reason }: { id: string; reason?: string }) =>
      run(principal, "runs:submit", async () => ok(await sessions.interruptTask(actor(), id, reason))),
  );

  server.registerTool(
    "read_sandbox_task_trace",
    {
      annotations: { readOnlyHint: true },
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
      // NOT a read: executes a shell command in the live session. The authz action (:read) says who may CALL, never what it DOES.
      annotations: { readOnlyHint: false },
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
      // NOT a read: destructive teardown — container down, trajectory sealed, run settled. The authz action (:read) says who may CALL, never what it DOES.
      annotations: { readOnlyHint: false },
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
