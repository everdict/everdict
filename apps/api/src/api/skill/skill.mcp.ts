import { NodeRefSchema, SkillFilesSchema, SkillVisibilitySchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Skill MCP tools — the MCP twin of skill.routes.ts (workspace SKILL.md procedures). Generation (skill-generate) is an
// interactive web flow, so it stays HTTP-only (like save_model/save_agent). The everdict agent's read-only tool
// allowlist bridges only list_/get_ from here, so the conversational agent can inspect the library but not mutate it.
export function registerSkillTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.skillService) return;
  const skills = deps.skillService;
  const actor = { subject: principal.subject, isAdmin: principal.roles.includes("admin") };

  server.registerTool(
    "list_skills",
    {
      description: "Workspace skills visible to the caller — every workspace skill plus their own private drafts",
      inputSchema: {},
    },
    () => run(principal, "skills:read", async () => ok(await skills.list(ws, principal.subject))),
  );

  server.registerTool(
    "get_skill",
    {
      description:
        "A single skill (name + description + instructions + supporting files). A workspace skill is visible to any member; a private one only to its creator (else NOT_FOUND)",
      inputSchema: { id: z.string() },
    },
    ({ id }) => run(principal, "skills:read", async () => ok(await skills.get(ws, id, principal.subject))),
  );

  server.registerTool(
    "create_skill",
    {
      description:
        "Author a workspace skill (a SKILL.md-style procedure the agent follows). Keep `instructions` (the SKILL.md body) lean; put long reference material into `files` [{path, content}] — each file is loaded on demand, never inlined. Pin the entities the skill documents in `refs` [{type, key, version?}] — the version pins are the staleness contract (a newer version flags the skill). Defaults to visibility 'private'; pass 'workspace' to share. Requires skills:write.",
      inputSchema: {
        name: z.string(),
        description: z.string(),
        instructions: z.string(),
        files: SkillFilesSchema.optional(),
        refs: z.array(NodeRefSchema).max(16).optional(),
        visibility: SkillVisibilitySchema.optional(),
      },
    },
    ({ name, description, instructions, files, refs, visibility }) =>
      run(principal, "skills:write", async () =>
        ok(
          await skills.create({
            tenant: ws,
            createdBy: principal.subject,
            name,
            description,
            instructions,
            ...(files ? { files } : {}),
            ...(refs ? { refs } : {}),
            ...(visibility ? { visibility } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "update_skill",
    {
      description:
        "Edit a skill or change its visibility (share = private→workspace). `files` replaces the whole supporting-file set when provided (fetch the current set via get_skill first for a file-level edit); omit it to keep files as-is. Only the creator or a workspace admin may manage it. Requires skills:write.",
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        instructions: z.string().optional(),
        files: SkillFilesSchema.optional(),
        refs: z.array(NodeRefSchema).max(16).optional(),
        visibility: SkillVisibilitySchema.optional(),
      },
    },
    ({ id, name, description, instructions, files, refs, visibility }) =>
      run(principal, "skills:write", async () =>
        ok(
          await skills.update(
            ws,
            id,
            {
              ...(name !== undefined ? { name } : {}),
              ...(description !== undefined ? { description } : {}),
              ...(instructions !== undefined ? { instructions } : {}),
              ...(files !== undefined ? { files } : {}),
              ...(refs !== undefined ? { refs } : {}),
              ...(visibility !== undefined ? { visibility } : {}),
            },
            actor,
          ),
        ),
      ),
  );

  server.registerTool(
    "verify_skill",
    {
      description:
        "Attest a skill's procedure still matches reality — EXTENDS each versioned pin's known-valid interval to the entity's current latest (verifiedVersion) plus the wall-clock verifiedAt, without counting as an edit. Use after checking a behind-flagged skill against the current versions; if the procedure has drifted, update the skill (re-pinning refs) instead. Manage = creator-or-admin. Requires skills:write.",
      inputSchema: { id: z.string() },
    },
    ({ id }) => run(principal, "skills:write", async () => ok(await skills.verify(ws, id, actor))),
  );

  server.registerTool(
    "delete_skill",
    {
      description:
        "Delete a workspace skill. Only the creator or a workspace admin may delete it. Requires skills:write.",
      inputSchema: { id: z.string() },
    },
    ({ id }) =>
      run(principal, "skills:write", async () => {
        await skills.remove(ws, id, actor);
        return ok({ id, deleted: true });
      }),
  );
}
