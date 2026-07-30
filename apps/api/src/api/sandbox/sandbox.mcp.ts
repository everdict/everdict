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
        "Open a sandbox session: boot an environment image as a long-lived container and shell in. Recorded as " +
        "a Run (kind sandbox, lifetime session) with a hard TTL; every exec lands on its trajectory, sealed at " +
        "close. Exactly one of image (ad-hoc pullable ref) or environment (an adopted environment capability) " +
        "is required.",
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
        ttlSec: z.number().int().positive().max(14400).optional().describe("Session TTL (default 900s)"),
      },
    },
    ({
      image,
      environment,
      ttlSec,
    }: { image?: string; environment?: { source?: string; id: string; version?: string }; ttlSec?: number }) =>
      run(principal, "runs:submit", async () =>
        ok(
          await sessions.create({
            tenant: ws,
            createdBy: principal.subject,
            ...(image !== undefined ? { image } : {}),
            ...(environment !== undefined ? { environment } : {}),
            ...(ttlSec !== undefined ? { ttlSec } : {}),
          }),
        ),
      ),
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
