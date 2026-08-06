import { TeamMemberRecordSchema, TeamRecordSchema, TeamSummarySchema } from "@everdict/contracts";
import { WorkflowStateRecordSchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { AddTeamMemberBodySchema, CreateTeamBodySchema, UpdateTeamBodySchema } from "./request/create-team.js";
import { CreateWorkflowStateBodySchema, UpdateWorkflowStateBodySchema } from "./request/workflow-state.js";

// OpenAPI descriptors for the tracker's teams (doc-only — never validates/serializes; see api/openapi.ts).
// A team owns ISSUES and names them (`ENG-12`); projects and initiatives stay workspace-level so a release
// several teams contribute to is still one readiness gate. Authz: read = teams:read (viewer+), write =
// teams:write (admin) — creating a team mints an identifier prefix and decides whose list issues land in,
// which is workspace administration rather than tracker content.
const TeamWithSummarySchema = TeamRecordSchema.extend({ summary: TeamSummarySchema });

export const teamDocs: Record<
  | "create"
  | "list"
  | "get"
  | "update"
  | "makeDefault"
  | "delete"
  | "listStates"
  | "createState"
  | "updateState"
  | "deleteState"
  | "listMembers"
  | "addMember"
  | "removeMember"
  | "join"
  | "leave",
  FastifySchema
> = {
  create: {
    summary: "Create a team",
    description:
      "Mint a team with an immutable identifier prefix. The first team in a workspace is the default whatever " +
      "the caller asks for — an issue filed without a team has to land somewhere. Emits team.created. " +
      "Requires teams:write.",
    tags: ["team"],
    body: toJsonSchema(CreateTeamBodySchema),
    response: {
      201: { description: "The created team", ...toJsonSchema(TeamRecordSchema) },
      ...errorResponses(400, 401, 403, 409),
    },
  },
  list: {
    summary: "List the workspace's teams",
    description:
      "Every team, or only the caller's with `mine=true`. Each row carries a derived summary (roster size, " +
      "open/total issues) — computed on read, never stored. Requires teams:read.",
    tags: ["team"],
    querystring: toJsonSchema(z.object({ mine: z.boolean().optional(), limit: z.number().int().optional() })),
    response: {
      200: { description: "Teams", ...toJsonSchema(z.array(TeamWithSummarySchema)) },
      ...errorResponses(401, 403),
    },
  },
  get: {
    summary: "Get a team",
    description: "The team plus its derived summary. A team in another workspace reads 404. Requires teams:read.",
    tags: ["team"],
    response: {
      200: { description: "The team", ...toJsonSchema(TeamWithSummarySchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  update: {
    summary: "Rename a team or edit its description",
    description:
      "Content editing — no fact, because a rename is not lifecycle news. The key cannot change: it is baked " +
      "into every identifier the team has minted. Requires teams:write.",
    tags: ["team"],
    body: toJsonSchema(UpdateTeamBodySchema),
    response: {
      200: { description: "The updated team", ...toJsonSchema(TeamRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  makeDefault: {
    summary: "Make this the workspace's default team",
    description:
      "Hands the default flag over: the incumbent is demoted and this team promoted in one call, so the " +
      "workspace is never left without a landing place for an unrouted issue. Requires teams:write.",
    tags: ["team"],
    response: {
      200: { description: "The promoted team", ...toJsonSchema(TeamRecordSchema) },
      ...errorResponses(401, 403, 404, 409),
    },
  },
  delete: {
    summary: "Delete a team",
    description:
      "Refuses (409) for the default team, for the last remaining team, and for a team that still holds " +
      "issues — naming the count. Creator-or-admin. Requires teams:write.",
    tags: ["team"],
    response: { 204: { description: "Deleted" }, ...errorResponses(401, 403, 404, 409) },
  },
  listStates: {
    summary: "The team's workflow states",
    description:
      "A team's own names for the positions in its workflow, in board order. Each state declares the CANONICAL " +
      "status it is a view onto — which is what lets a team rename a column, recolour it, reorder the board or " +
      "add one without any of it reaching the release gate, the rollups or the regression watch. A team with " +
      "no board yet gets the default six here. Requires teams:read.",
    tags: ["team"],
    response: {
      200: { description: "States in board order", ...toJsonSchema(z.array(WorkflowStateRecordSchema)) },
      ...errorResponses(401, 403, 404),
    },
  },
  createState: {
    summary: "Add a workflow state",
    description:
      "A new column at the end of the board, declaring which canonical status it is. `regressed` is refused: " +
      "an issue reaches it by a resolution falling, never by somebody dragging a card. A duplicate name is a " +
      "409. Requires teams:write.",
    tags: ["team"],
    body: toJsonSchema(CreateWorkflowStateBodySchema),
    response: {
      201: { description: "The new state", ...toJsonSchema(WorkflowStateRecordSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  updateState: {
    summary: "Rename, recolour, reorder or re-map a state",
    description:
      "Renaming and recolouring are cosmetic; changing `position` reorders the board; changing `status` " +
      "RE-MAPS the column, which moves every issue in it to that canonical status in the same operation — the " +
      "board and the record can never disagree. Requires teams:write.",
    tags: ["team"],
    body: toJsonSchema(UpdateWorkflowStateBodySchema),
    response: {
      200: { description: "The updated state", ...toJsonSchema(WorkflowStateRecordSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  deleteState: {
    summary: "Remove a workflow state",
    description:
      "Refused with a 409 while the state still holds issues (they would name a column that no longer exists) " +
      "and refused for the last remaining state. Requires teams:write.",
    tags: ["team"],
    response: { 204: { description: "Deleted" }, ...errorResponses(401, 403, 404, 409) },
  },
  listMembers: {
    summary: "List a team's roster",
    description: "Team membership is its own roster, separate from workspace membership. Requires teams:read.",
    tags: ["team"],
    response: {
      200: { description: "Members", ...toJsonSchema(z.array(TeamMemberRecordSchema)) },
      ...errorResponses(401, 403, 404),
    },
  },
  addMember: {
    summary: "Add someone to a team",
    description: "Emits team.member_added. Requires teams:write.",
    tags: ["team"],
    body: toJsonSchema(AddTeamMemberBodySchema),
    response: {
      201: { description: "The membership", ...toJsonSchema(TeamMemberRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  removeMember: {
    summary: "Remove someone from a team",
    description: "Emits team.member_removed. Requires teams:write.",
    tags: ["team"],
    response: { 204: { description: "Removed" }, ...errorResponses(401, 403, 404) },
  },
  join: {
    summary: "Join a team yourself",
    description:
      'Self-service membership — puts the CALLER on the roster (Linear\'s "Join teams"). A private team the ' +
      "caller cannot see answers 404, never 403; already being on the team is a 409. Emits team.member_added. " +
      "Requires teams:join (member+).",
    tags: ["team"],
    response: {
      201: { description: "The membership", ...toJsonSchema(TeamMemberRecordSchema) },
      ...errorResponses(401, 403, 404, 409),
    },
  },
  leave: {
    summary: "Leave a team yourself",
    description:
      "The mirror of join — removes the CALLER from the roster. Not being on the team (or the team being " +
      "invisible to the caller) answers 404. Emits team.member_removed. Requires teams:join (member+).",
    tags: ["team"],
    response: { 204: { description: "Left" }, ...errorResponses(401, 403, 404) },
  },
};
