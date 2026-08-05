import {
  type TeamTransferableRegistry,
  type TransferableCapability,
  moveCapabilityToTeam,
} from "@everdict/application-control";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { type McpToolContext, ok, plain, resolveTeam } from "./mcp-context.js";
import { errorResponses, toJsonSchema } from "./openapi.js";

// Handing something to another team — the shared transport surface of the write half of the team axis
// (`moveCapabilityToTeam` / `ScorecardService.moveToTeam` are the cores). One body and one result for every
// re-fileable resource, because it is ONE act with one shape; a per-resource copy is how four endpoints drift
// into four spellings of the same thing.
//
// Each gets its own endpoint (`POST /<resource>/:id/team`) rather than a field on the resource's edit, for the
// reason the issue move already has one: this is a TRANSITION — it re-files every version at once and emits its
// own fact — and burying it in a content edit would let a rename carry an ownership change as a side effect.

// `teamId` takes an id or a key (`ENG`), the same ref every team-scoped URL carries; the route resolves it
// (`resolveTeamRef`) before any gate sees it, so an unknown team is a 404 rather than a puzzling 403.
export const MoveToTeamBodySchema = z.object({
  teamId: z.string().min(1).max(200),
});

// `previousTeamId` is absent when the thing was unowned (registered before the axis, or seeded) — absent means
// "nobody owned it", never "the workspace" or "everyone".
export const MoveToTeamResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  teamId: z.string(),
  previousTeamId: z.string().optional(),
});

// The MCP twin of the move route, registered by each capability's own `<resource>.mcp.ts` (the tool belongs to
// its slice; only the body is shared, exactly as the routes share `moveCapabilityToTeam`). The service does the
// authorizing — both teams — so this runs under `plain` rather than a role gate that would only re-ask half the
// question.
export function registerCapabilityMoveTool(
  server: McpServer,
  ctx: McpToolContext,
  input: { tool: string; registry: TeamTransferableRegistry; capability: TransferableCapability; description: string },
): void {
  server.registerTool(
    input.tool,
    {
      description: input.description,
      inputSchema: {
        id: z.string(),
        team: z.string().describe('the destination team — id or key ("ENG")'),
      },
    },
    ({ id, team }) =>
      plain(async () =>
        ok(
          await moveCapabilityToTeam({
            registry: input.registry,
            capability: input.capability,
            principal: ctx.principal,
            id,
            // An agent names a team the way a person does; an unknown one is a 404 here rather than a confusing
            // refusal at the gate.
            teamId: await resolveTeam(ctx, team),
            ...(ctx.deps.platformEvents ? { events: ctx.deps.platformEvents } : {}),
            ...(ctx.agent?.agentId !== undefined ? { agent: ctx.agent } : {}),
          }),
        ),
      ),
  );
}

// A move tool's description: what is specific to this resource, then the half that is true of every transfer.
// The tool schema IS the doc an agent reads, so the refusals belong in it — an agent that learns them only by
// being refused has already surprised somebody.
export function moveToolDescription(specific: string): string {
  return `${specific} You must be on BOTH teams — the one it is leaving and the one it is joining (an admin passes both). \`team\` takes an id or a key (ENG). Moving it to the team it is already on is a CONFLICT, and one this workspace does not own (a _shared entry) is NOT_FOUND.`;
}

// The OpenAPI descriptor, built once. `resource` names the thing in the summary; `extra` is where a resource
// says what is specific to it (a dataset re-files every version, a scorecard is a single result record).
export function teamMoveDocs(input: {
  resource: string;
  tag: string;
  extra: string;
  idDescription: string;
  action: string;
}): FastifySchema {
  const shared =
    "Both teams are checked: you must be on the one it is leaving (or moving it out would be a way to take " +
    "it) and on the one it is joining (or this becomes a way to push work into another team's hands). An " +
    "admin passes both. `teamId` accepts an id or a key (`ENG`); an unknown team is 404, and so is one this " +
    "workspace does not own. Moving it to the team it is already on is 409.";
  return {
    summary: `Move a ${input.resource} to another team`,
    description: `Hand the ${input.resource} to another team. ${input.extra} ${shared} Requires ${input.action}.`,
    tags: [input.tag],
    params: {
      type: "object",
      properties: { id: { type: "string", description: input.idDescription } },
      required: ["id"],
    },
    body: toJsonSchema(MoveToTeamBodySchema),
    response: {
      200: { description: "The new owner", ...toJsonSchema(MoveToTeamResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  };
}
