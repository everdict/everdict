import { EVERDICT_ROLES } from "@everdict/auth";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, plain, run } from "../mcp-context.js";

export function registerMemberTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.membershipService) {
    const membership = deps.membershipService;
    server.registerTool(
      "list_members",
      { description: "This workspace's members (subject·role·email·joined-at)", inputSchema: {} },
      () => run(principal, "members:read", async () => ok(await membership.listMembers(ws))),
    );
    server.registerTool(
      "set_member_role",
      {
        description:
          "Change a member's role (viewer|member|admin). NOT_FOUND if not a member, CONFLICT when demoting the last admin.",
        inputSchema: { subject: z.string(), role: z.enum(EVERDICT_ROLES) },
      },
      ({ subject, role }) =>
        run(principal, "members:write", async () => {
          await membership.setRole(ws, subject, role);
          return ok({ workspace: ws, subject, role });
        }),
    );
    server.registerTool(
      "remove_member",
      {
        description: "Remove a member (idempotent). Removing the last admin is CONFLICT.",
        inputSchema: { subject: z.string() },
      },
      ({ subject }) =>
        run(principal, "members:write", async () => {
          await membership.removeMember(ws, subject);
          return ok({ workspace: ws, subject, removed: true });
        }),
    );
  }

  if (deps.membershipService) {
    const membership = deps.membershipService;
    server.registerTool(
      "leave_workspace",
      {
        description:
          "Leave this workspace (self-serve, your own membership only). The last admin can't leave (error). After leaving, scope to another workspace.",
        inputSchema: {},
      },
      () =>
        plain(async () => {
          await membership.leaveWorkspace(ws, principal.subject);
          return ok({ workspace: ws, left: true });
        }),
    );
  }
}
