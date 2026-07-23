import { SkillRecordSchema } from "@everdict/contracts";
import { GenerateSkillResultSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CreateSkillBodySchema } from "./request/create-skill.js";
import { GenerateSkillBodySchema } from "./request/generate-skill.js";
import { UpdateSkillBodySchema } from "./request/update-skill.js";

// OpenAPI descriptors for the skill routes — doc-only (rule api-layer): attaching these is behavior-free.

const idParams = { type: "object", properties: { id: { type: "string", description: "Skill id" } }, required: ["id"] };

const docs = {
  create: {
    summary: "Author a workspace skill",
    description:
      "Creates a SKILL.md-style procedure (name + description + instructions) the conversational agent follows. " +
      "Defaults to visibility 'private' (a personal draft); share to the workspace via visibility 'workspace'. " +
      "Requires skills:write (member+).",
    tags: ["skill"],
    body: toJsonSchema(CreateSkillBodySchema),
    response: {
      200: { description: "Created skill", ...toJsonSchema(SkillRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  list: {
    summary: "List skills",
    description:
      "Lists the skills the caller can see — every workspace skill plus their own private drafts. Requires skills:read (viewer+).",
    tags: ["skill"],
    response: {
      200: { description: "Skills", ...toJsonSchema(z.array(SkillRecordSchema)) },
      ...errorResponses(401, 403, 404),
    },
  },
  get: {
    summary: "Get a skill",
    description:
      "A workspace skill is visible to any member; a private one only to its creator (otherwise 404). Requires skills:read.",
    tags: ["skill"],
    params: idParams,
    response: { 200: { description: "Skill", ...toJsonSchema(SkillRecordSchema) }, ...errorResponses(401, 403, 404) },
  },
  update: {
    summary: "Edit a skill or change its visibility",
    description:
      "Edits fields or shares/unshares (visibility private↔workspace). Requires skills:write; only the skill's creator " +
      "or a workspace admin may manage it (enforced in the service — private = 404 to others, workspace = 403).",
    tags: ["skill"],
    params: idParams,
    body: toJsonSchema(UpdateSkillBodySchema),
    response: {
      200: { description: "Updated skill", ...toJsonSchema(SkillRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  remove: {
    summary: "Delete a skill",
    description:
      "Deletes a skill. Requires skills:write; only the creator or a workspace admin may delete it (service-enforced).",
    tags: ["skill"],
    params: idParams,
    response: { 204: { description: "Deleted" }, ...errorResponses(401, 403, 404) },
  },
  generate: {
    summary: "Generate a skill draft (skill-generate)",
    description:
      "Drafts a skill (name + description + instructions) from a natural-language description via the workspace's " +
      "registered model + key. Persists nothing — the member edits the draft and saves via POST /skills. Requires " +
      "skills:write (a real billable model call). An unknown model is 404; a missing key is 400.",
    tags: ["skill"],
    body: toJsonSchema(GenerateSkillBodySchema),
    response: {
      200: { description: "Draft skill", ...toJsonSchema(GenerateSkillResultSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

export const skillDocs: Record<keyof typeof docs, FastifySchema> = docs;
