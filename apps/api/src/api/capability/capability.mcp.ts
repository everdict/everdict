import { CapabilitySpecSchema, CapabilityVisibilitySchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Capability Store MCP tools — the MCP twin of capability.routes.ts (one entity: mcp|code|skill). The everdict
// agent's read-only tool allowlist bridges list_/get_ from here, so the conversational agent can BROWSE the Store
// (its own + shared + public) but not publish or delete.
export function registerCapabilityTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.capabilityService) return;
  const caps = deps.capabilityService;
  const actor = { subject: principal.subject, isAdmin: principal.roles.includes("admin") };

  server.registerTool(
    "list_capabilities",
    {
      description:
        "Capabilities visible to my workspace — own private (mine) + workspace + subset + subset shared to me (latest live version each). Excludes the global public catalog (use list_public_capabilities)",
      inputSchema: {},
    },
    () => run(principal, "capabilities:read", async () => ok(await caps.list(ws, principal.subject))),
  );

  server.registerTool(
    "list_public_capabilities",
    {
      description:
        "The public capability catalog — every capability published 'public' across all workspaces (latest live version each)",
      inputSchema: {},
    },
    () => run(principal, "capabilities:read", async () => ok(await caps.listPublic())),
  );

  server.registerTool(
    "get_capability",
    {
      description:
        "A single capability (name + description + discriminated spec). The latest version, or an exact one via `version`. Not visible / missing → NOT_FOUND",
      inputSchema: { id: z.string(), version: z.string().optional() },
    },
    ({ id, version }) =>
      run(principal, "capabilities:read", async () =>
        ok(await caps.get(ws, id, principal.subject, version ?? "latest")),
      ),
  );

  server.registerTool(
    "save_capability",
    {
      description:
        "Author (create or edit) a capability — version-free upsert (new id → 1.0.0; a content change → next patch version; unchanged → no-op). `visibility`/`sharedWith` apply only when creating; editing inherits the current reach (change it via set_capability_visibility). Publishing a new capability as 'public' requires an admin. Requires capabilities:write.",
      inputSchema: {
        id: z.string(),
        name: z.string(),
        description: z.string(),
        spec: CapabilitySpecSchema,
        visibility: CapabilityVisibilitySchema.optional(),
        sharedWith: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    ({ id, name, description, spec, visibility, sharedWith, tags }) =>
      run(principal, "capabilities:write", async () =>
        ok(
          await caps.save(ws, actor, id, {
            name,
            description,
            spec,
            ...(visibility !== undefined ? { visibility } : {}),
            ...(sharedWith !== undefined ? { sharedWith } : {}),
            ...(tags !== undefined ? { tags } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "set_capability_visibility",
    {
      description:
        "Change a capability's reach across every live version: private | workspace | subset (with `sharedWith` target workspace ids — your own) | public. Owner-or-admin; promoting to 'public' requires an admin. Requires capabilities:write.",
      inputSchema: {
        id: z.string(),
        visibility: CapabilityVisibilitySchema,
        sharedWith: z.array(z.string()).optional(),
      },
    },
    ({ id, visibility, sharedWith }) =>
      run(principal, "capabilities:write", async () =>
        ok(await caps.setVisibility(ws, id, { visibility, sharedWith: sharedWith ?? [] }, actor)),
      ),
  );

  server.registerTool(
    "delete_capability",
    {
      description:
        "Soft-delete a single capability version (tombstone; content preserved). Only the version's creator or a workspace admin. Requires capabilities:write.",
      inputSchema: { id: z.string(), version: z.string() },
    },
    ({ id, version }) =>
      run(principal, "capabilities:write", async () => {
        await caps.deleteVersion(ws, id, version, actor);
        return ok({ id, version, deleted: true });
      }),
  );
}
