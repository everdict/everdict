import { TEAM_TRANSFERABLE_CAPABILITIES } from "@everdict/application-control";
import { HarnessTemplateSpecSchema } from "@everdict/contracts";
import { ownedByVisibleTeam } from "@everdict/domain";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertEntityVisible, visibleTeamsFor } from "../../common/team-scope.js";
import { type McpToolContext, fail, ok, resolveTeam, run, runForTeam } from "../mcp-context.js";
import { moveToolDescription, registerCapabilityMoveTool } from "../team-move.js";

// Harness-template MCP tools — the MCP twin of harness-template.routes.ts.
// A private team's authored entry is that team's — the same ceiling the HTTP twin stays under.
async function keepVisible<T extends { teamId?: string }>(ctx: McpToolContext, rows: T[]): Promise<T[]> {
  const seen = await visibleTeamsFor(ctx.deps, ctx.principal);
  return rows.filter((row) => ownedByVisibleTeam(row, seen));
}

export function registerHarnessTemplateTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  // Harness category (template: structure/slots). No gate (viewer+) — collaborative content.
  if (deps.harnessTemplates) {
    const templates = deps.harnessTemplates;
    server.registerTool(
      "list_harness_templates",
      {
        description:
          "Harness templates this workspace sees (categories; owned + _shared). `team` narrows to one team's " +
          "own templates (id or key, ENG).",
        inputSchema: { team: z.string().optional().describe('only this team\'s templates — id or key ("ENG")') },
      },
      ({ team }) =>
        run(principal, "harnesses:read", async () => {
          const visible = await keepVisible(ctx, await templates.list(ws));
          if (team === undefined) return ok(visible);
          const teamId = await resolveTeam(ctx, team);
          return ok(visible.filter((entry) => entry.teamId === teamId));
        }),
    );

    server.registerTool(
      "get_harness_template",
      {
        description:
          "Fetch one harness template (category) structure spec — for config view / new-version edit prefill",
        inputSchema: { id: z.string(), version: z.string().describe('template version or "latest"') },
      },
      ({ id, version }) =>
        run(principal, "harnesses:read", async () => {
          await assertEntityVisible(ctx.deps, principal, templates, ws, id, "harness template");
          return ok(await templates.get(ws, id, version));
        }),
    );

    server.registerTool(
      "register_harness_template",
      {
        description:
          "Register a harness template (category structure, JSON string) (immutable; CONFLICT on clash). No gate (viewer+)",
        inputSchema: {
          spec: z.string().describe("HarnessTemplateSpec JSON"),
          team: z
            .string()
            .optional()
            .describe(
              'the owning team — id or key ("ENG"). A team you are not on is refused. Absent: your own team, else the workspace default',
            ),
        },
      },
      ({ spec, team }) =>
        // Owner resolved and AUTHORIZED before the write (the HTTP twin's teamForNew + gate pair).
        runForTeam(ctx, "templates:write", team, async (teamId) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(spec);
          } catch {
            return fail("BAD_REQUEST: not a valid HarnessTemplateSpec JSON.");
          }
          const result = HarnessTemplateSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await templates.register(ws, result.data, principal.subject, teamId); // creator stamp — HTTP parity
          return ok({ workspace: ws, id: result.data.id, version: result.data.version, ...(teamId ? { teamId } : {}) });
        }),
    );

    registerCapabilityMoveTool(server, ctx, {
      tool: "move_harness_template",
      registry: templates,
      capability: TEAM_TRANSFERABLE_CAPABILITIES.harnessTemplate,
      description: moveToolDescription(
        "Hand a harness template (the SHAPE) to another team. EVERY version of the shape moves; instances that " +
          "pin it are their own entities and keep their own team (move those with move_harness).",
      ),
    });
  }
}
