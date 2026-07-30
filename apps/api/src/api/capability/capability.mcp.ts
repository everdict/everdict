import { CapabilitySpecSchema, CapabilityVisibilitySchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Capability Store MCP tools — the MCP twin of capability.routes.ts (one entity: mcp|code|skill|environment). The everdict
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
    () => run(principal, "capabilities:read", async () => ok(await caps.listPublic(ws))),
  );

  server.registerTool(
    "get_capability",
    {
      description:
        "A single capability (name + description + discriminated spec). The latest version, or an exact one via `version`. `source` reads a cross-tenant public/subset owner (defaults to my workspace). Not visible / missing → NOT_FOUND",
      inputSchema: { id: z.string(), version: z.string().optional(), source: z.string().optional() },
    },
    ({ id, version, source }) =>
      run(principal, "capabilities:read", async () =>
        ok(await caps.get(ws, id, principal.subject, version ?? "latest", source)),
      ),
  );

  server.registerTool(
    "list_capability_versions",
    {
      description:
        "Live versions (ascending) + per-version tags for one capability id — my workspace by default, or a cross-tenant public/subset owner via `source`. Not visible / missing → NOT_FOUND. Requires capabilities:read.",
      inputSchema: { id: z.string(), source: z.string().optional() },
    },
    ({ id, source }) =>
      run(principal, "capabilities:read", async () => ok(await caps.listVersions(ws, principal.subject, id, source))),
  );

  server.registerTool(
    "diff_capability_versions",
    {
      description:
        'Structural diff between two versions of the same capability, over the immutable content (name/description/spec) — leaf field changes by path, typeChanged flag for a kind restructure (mcp ↔ code ↔ skill ↔ environment). Both refs accept "latest". `source` diffs a cross-tenant public/subset owner (defaults to my workspace). Requires capabilities:read. Reproducible by the immutable-version guarantee.',
      inputSchema: {
        id: z.string(),
        base: z.string().describe('base version ref (accepts "latest")'),
        candidate: z.string().describe('candidate version ref (accepts "latest")'),
        source: z.string().optional(),
      },
    },
    ({ id, base, candidate, source }) =>
      run(principal, "capabilities:read", async () =>
        ok(await caps.diff(ws, principal.subject, id, base, candidate, source)),
      ),
  );

  if (deps.probeCapabilityMcp) {
    const probe = deps.probeCapabilityMcp;
    server.registerTool(
      "probe_capability_mcp",
      {
        description:
          "Test-connect to an MCP server URL (Streamable HTTP) and list its tools — verify reachability and discover the tool names before authoring an mcp capability. A failure is a result (reachable:false + reason), never an error. `token` is a transient bearer for the test only (never stored). Requires capabilities:write.",
        inputSchema: { url: z.string(), token: z.string().optional() },
      },
      ({ url, token }) =>
        run(principal, "capabilities:write", async () => ok(await probe(url, token ? { token } : {}))),
    );
  }

  server.registerTool(
    "validate_capability",
    {
      description:
        "Dry-run a capability save WITHOUT writing: parse the spec and report whether it would create a new capability or a new version (and which), the existing live versions, and — for an environment kind — image pull-readiness warnings. Bad spec → { ok:false, errors }. Requires capabilities:write.",
      inputSchema: {
        id: z.string(),
        name: z.string(),
        description: z.string(),
        spec: CapabilitySpecSchema,
      },
    },
    ({ id, name, description, spec }) =>
      run(principal, "capabilities:write", async () =>
        ok({ ok: true, ...(await caps.validate(ws, id, { name, description, spec })) }),
      ),
  );

  server.registerTool(
    "save_capability",
    {
      description:
        "Author (create or edit) a capability — version-free upsert (new id → 1.0.0; a content change → next patch version; unchanged → no-op). `visibility`/`sharedWith` apply only when creating; editing inherits the current reach (change it via set_capability_visibility). Omitted on create, `visibility` defaults BY KIND: an `environment` (the image a harness pins, used workspace-wide) → 'workspace', a tool kind → 'private'. Publishing a new capability as 'public' requires an admin. Requires capabilities:write.",
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
    "set_capability_version_tags",
    {
      description:
        "Replace a capability version's full tag set (empty array = remove all) — free-form labels to tell versions apart, outside spec immutability (each ≤60 chars, ≤20 per version; replace semantics). Only the version's creator or a workspace admin. Requires capabilities:write.",
      inputSchema: {
        id: z.string(),
        version: z.string().describe("exact version (latest not allowed)"),
        tags: z.array(z.string()).describe("this version's full tag set (replace semantics)"),
      },
    },
    ({ id, version, tags }) =>
      run(principal, "capabilities:write", async () => ok(await caps.setVersionTags(ws, id, version, tags, actor))),
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
