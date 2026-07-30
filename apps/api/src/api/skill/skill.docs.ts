import { SkillRecordSchema, SkillVersionRecordSchema } from "@everdict/contracts";
import { GenerateSkillResultSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CreateSkillBodySchema } from "./request/create-skill.js";
import { GenerateSkillBodySchema } from "./request/generate-skill.js";
import { ImportSkillBodySchema } from "./request/import-skill.js";
import { StampSkillVersionBodySchema } from "./request/stamp-skill-version.js";
import { UpdateSkillBodySchema } from "./request/update-skill.js";

// OpenAPI descriptors for the skill routes — doc-only (rule api-layer): attaching these is behavior-free.

const idParams = { type: "object", properties: { id: { type: "string", description: "Skill id" } }, required: ["id"] };

const docs = {
  create: {
    summary: "Author a workspace skill",
    description:
      "Creates a SKILL.md-style procedure (name + description + instructions + optional supporting files) the " +
      "conversational agent follows with progressive disclosure — the body loads on demand, each file individually. " +
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
  verify: {
    summary: "Verify a skill (attest it still holds)",
    description:
      "Extends each versioned pin's known-valid interval to the entity's current latest (verifiedVersion) and stamps " +
      "the wall-clock verifiedAt, without counting as an edit (updatedAt is untouched). Use after checking the " +
      "procedure against the current versions of its pinned refs. Requires skills:write; manage = creator-or-admin " +
      "(service-enforced).",
    tags: ["skill"],
    params: idParams,
    response: {
      200: { description: "Verified skill", ...toJsonSchema(SkillRecordSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  importFromStore: {
    summary: "Take a store skill into this workspace",
    description:
      "Copies a published skill — an Everdict example or one another workspace published — into this workspace's " +
      "library as a skill the members OWN: editable here, with its own version line starting at the version copied. " +
      "There is no live link back to the publication (`origin` records where it came from). Taking the same " +
      "publication twice is 409; a non-skill capability is 400. Requires skills:write (member+).",
    tags: ["skill"],
    body: toJsonSchema(ImportSkillBodySchema),
    response: {
      200: { description: "The workspace's copy", ...toJsonSchema(SkillRecordSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  stamp: {
    summary: "Stamp the skill's current content as a version",
    description:
      "Freezes what the skill says right now as an immutable version and moves the skill's version pointer to it. " +
      "`bump` (default patch) or an explicit `version` that must order above the current one (else 400); a version " +
      "already on the line is 409 — stamped versions are never rewritten. The content is read filesystem-first, so a " +
      "body an agent rewrote is what gets frozen. Not an edit: updatedAt is untouched. Requires skills:write; manage " +
      "= creator-or-admin (service-enforced).",
    tags: ["skill"],
    params: idParams,
    body: toJsonSchema(StampSkillVersionBodySchema),
    response: {
      200: {
        description: "The skill at its new version, plus the version stamped",
        ...toJsonSchema(z.object({ skill: SkillRecordSchema, stamped: SkillVersionRecordSchema })),
      },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  versions: {
    summary: "List a skill's stamped versions",
    description: "The skill's version line, newest first. Requires skills:read (viewer+).",
    tags: ["skill"],
    params: idParams,
    response: {
      200: { description: "Versions", ...toJsonSchema(z.array(SkillVersionRecordSchema)) },
      ...errorResponses(401, 403, 404),
    },
  },
  version: {
    summary: "Get one stamped version of a skill",
    description: "The frozen content of one version — what the procedure said at that point. Requires skills:read.",
    tags: ["skill"],
    params: {
      type: "object",
      properties: { id: { type: "string", description: "Skill id" }, version: { type: "string" } },
      required: ["id", "version"],
    },
    response: {
      200: { description: "Version", ...toJsonSchema(SkillVersionRecordSchema) },
      ...errorResponses(401, 403, 404),
    },
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
