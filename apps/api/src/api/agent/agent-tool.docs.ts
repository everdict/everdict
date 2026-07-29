import { AgentSkillListResponseSchema, AgentToolListResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { SetAgentToolBodySchema } from "./request/set-agent-tool.js";

// OpenAPI descriptors for /agent/tools + /agent/skills — doc-only (rule api-layer); validation stays in the handlers.

const SELF_SCOPED = [
  "Self-scoped: any member of the workspace may read and set their own. Affects only this member — the workspace",
  "AgentSpec and skill library are untouched, which is how two members of one workspace get two different agents.",
].join(" ");

const docs = {
  listTools: {
    summary: "List the caller's agent toolset",
    description: [
      "Every tool the calling member can put on the workspace assistant, with the effective on/off for THEM:",
      "first-party defaults (builtin), tools shared at the workspace (adopted on the AgentSpec, hand-wired MCP",
      "servers, or published workspace-wide), and the member's own private publications (personal). Each row also",
      "reports the workspace baseline, so a row where enabled differs from baseline is the member's own override.",
      SELF_SCOPED,
    ].join(" "),
    tags: ["agent"],
    response: {
      200: { description: "The caller's toolset", ...toJsonSchema(AgentToolListResponseSchema) },
      ...errorResponses(401, 404),
    },
  },
  setTool: {
    summary: "Turn one tool on or off for the caller",
    description: [
      "Sets the calling member's own decision about one tool (enabled true/false), or clears it with null so they",
      "follow the workspace baseline again. A key that is not in the caller's toolset is 404.",
      SELF_SCOPED,
      "Returns the refreshed toolset.",
    ].join(" "),
    tags: ["agent"],
    body: toJsonSchema(SetAgentToolBodySchema),
    response: {
      200: { description: "The refreshed toolset", ...toJsonSchema(AgentToolListResponseSchema) },
      ...errorResponses(400, 401, 404),
    },
  },
  listSkills: {
    summary: "List the caller's agent skill set",
    description: [
      "Every skill the workspace supports, with the effective on/off for THIS member: skills authored here",
      "(including the caller's own private drafts), skill packages adopted or published in this workspace, and the",
      "first-party built-ins. The workspace library says what exists; this says what the member's agent follows.",
      SELF_SCOPED,
    ].join(" "),
    tags: ["agent"],
    response: {
      200: { description: "The caller's skill set", ...toJsonSchema(AgentSkillListResponseSchema) },
      ...errorResponses(401, 404),
    },
  },
  setSkill: {
    summary: "Turn one skill on or off for the caller",
    description: [
      "Sets the calling member's own decision about one skill (enabled true/false), or clears it with null so they",
      "follow the workspace baseline again. A key that is not in the caller's skill set is 404.",
      SELF_SCOPED,
      "Returns the refreshed skill set.",
    ].join(" "),
    tags: ["agent"],
    body: toJsonSchema(SetAgentToolBodySchema),
    response: {
      200: { description: "The refreshed skill set", ...toJsonSchema(AgentSkillListResponseSchema) },
      ...errorResponses(400, 401, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Widened re-export (team convention): keeps the doc attachment behavior-free (no reply.code() narrowing).
export const agentToolDocs: Record<keyof typeof docs, FastifySchema> = docs;
