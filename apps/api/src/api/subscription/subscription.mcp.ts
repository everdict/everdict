import type { UpdateSubscriptionInput } from "@everdict/application-control";
import {
  SubscriptionGovernanceSchema,
  SubscriptionReactionSchema,
  SubscriptionSelectorSchema,
} from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Subscription registry tools — the MCP transport over the SAME SubscriptionService the HTTP routes use
// (BFF↔MCP parity). Authz mirrors the routes: read = agents:read, write = agents:write.
export function registerSubscriptionTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.subscriptionService) return;
  const subscriptions = deps.subscriptionService;

  server.registerTool(
    "create_subscription",
    {
      description:
        "Create a subscription — turn a platform event into a reaction: selector (event kinds + payload filters) → reaction (agent: wake a crafted agent | webhook: signed POST of the fact | workflow: durable multi-step agent chain) under governance (enabled, cooldownSec).",
      inputSchema: {
        name: z.string(),
        selector: SubscriptionSelectorSchema,
        reaction: SubscriptionReactionSchema,
        governance: SubscriptionGovernanceSchema.optional(),
      },
    },
    (a) =>
      run(principal, "agents:write", async () =>
        ok(
          await subscriptions.create({
            tenant: ws,
            createdBy: principal.subject,
            name: a.name,
            selector: a.selector,
            reaction: a.reaction,
            ...(a.governance !== undefined ? { governance: a.governance } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_subscriptions",
    { description: "List the workspace's subscriptions (event → reaction rules)", inputSchema: {} },
    () => run(principal, "agents:read", async () => ok(await subscriptions.list(ws))),
  );

  server.registerTool(
    "update_subscription",
    {
      description:
        "Update a subscription — change name/selector/reaction/governance (a present block replaces the stored one whole). Creator or workspace admin only.",
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        selector: SubscriptionSelectorSchema.optional(),
        reaction: SubscriptionReactionSchema.optional(),
        governance: SubscriptionGovernanceSchema.optional(),
      },
    },
    (a) =>
      run(principal, "agents:write", async () => {
        const patch: UpdateSubscriptionInput = {};
        if (a.name !== undefined) patch.name = a.name;
        if (a.selector !== undefined) patch.selector = a.selector;
        if (a.reaction !== undefined) patch.reaction = a.reaction;
        if (a.governance !== undefined) patch.governance = a.governance;
        return ok(
          await subscriptions.update(ws, a.id, patch, {
            subject: principal.subject,
            isAdmin: principal.roles.includes("admin"),
          }),
        );
      }),
  );

  server.registerTool(
    "delete_subscription",
    {
      description: "Delete a subscription — creator or workspace admin only (other workspaces get NOT_FOUND)",
      inputSchema: { id: z.string() },
    },
    ({ id }) =>
      run(principal, "agents:write", async () => {
        await subscriptions.remove(ws, id, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        });
        return ok({ id, deleted: true });
      }),
  );
}
