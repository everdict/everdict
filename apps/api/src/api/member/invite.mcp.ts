import { EVERDICT_ROLES } from "@everdict/auth";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, plain, run } from "../mcp-context.js";

export function registerInviteTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.membershipService) {
    const membership = deps.membershipService;
    server.registerTool(
      "list_invites",
      {
        description:
          "This workspace's active invite links (metadata only — no token/hash; acceptedCount = joins so far)",
        inputSchema: {},
      },
      () => run(principal, "members:write", async () => ok(await membership.listInvites(ws))),
    );
    server.registerTool(
      "create_invite",
      {
        description:
          "Issue a reusable invite link. The response token (inv_…) is shown once — share it, and anyone with the link joins with that role until it expires or you revoke it.",
        inputSchema: { role: z.enum(EVERDICT_ROLES), expiresInHours: z.number().int().positive().max(8760).optional() },
      },
      ({ role, expiresInHours }) =>
        run(principal, "members:write", async () => {
          const { token, meta } = await membership.createInvite({
            workspace: ws,
            role,
            createdBy: principal.subject,
            ...(expiresInHours !== undefined ? { expiresInHours } : {}),
          });
          return ok({ ...meta, token });
        }),
    );
    server.registerTool(
      "revoke_invite",
      {
        description: "Revoke an invite link so it can no longer be used (id is the id from list_invites)",
        inputSchema: { id: z.string() },
      },
      ({ id }) =>
        run(principal, "members:write", async () => {
          await membership.revokeInvite(ws, id);
          return ok({ workspace: ws, id, revoked: true });
        }),
    );
    server.registerTool(
      "accept_invite",
      {
        description:
          "Accept an invite token → join that workspace (no role gate; human accounts only). Expired/invalid → error.",
        inputSchema: { token: z.string() },
      },
      ({ token }) => plain(async () => ok(await membership.acceptInvite(principal, token))),
    );
  }
}
