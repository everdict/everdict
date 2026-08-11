import { CheckpointListResponseSchema, CheckpointResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CreateCheckpointBodySchema } from "./request/create-checkpoint.js";

// OpenAPI descriptors for the handoff-checkpoint routes (doc-only — never validates/serializes; see
// api/openapi.ts). Authz reuses the agent actions (no new action): read = agents:read, write = agents:write.
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
export const checkpointDocs: Record<"create" | "list" | "get" | "verify", FastifySchema> = {
  create: {
    summary: "Publish a handoff checkpoint",
    description:
      "Record a resumable state transfer for work that stopped — typically because its task envelope's " +
      "budget ran out or a tool fell outside its scope. Requires agents:write. The id, timestamp and " +
      "authorship are stamped by the control plane, never supplied. Two admission rules apply and both " +
      "return 400: every confirmedFacts reference must resolve against real records (a 'fact' whose " +
      "evidence cannot be found is a hypothesis, and the payload has a field for those), and an actor may " +
      "not file a verifier checkpoint about a run it executed itself.",
    tags: ["checkpoint"],
    body: toJsonSchema(CreateCheckpointBodySchema),
    response: {
      201: { description: "The published checkpoint", ...toJsonSchema(CheckpointResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  list: {
    summary: "List handoff checkpoints",
    description:
      "The workspace's handoffs, newest first. Requires agents:read. envelopeId narrows to one task's " +
      "checkpoints — how that task stopped, and what it left behind.",
    tags: ["checkpoint"],
    querystring: toJsonSchema(
      z.object({
        envelopeId: z.string().optional().describe("Only checkpoints suspending this task envelope"),
        limit: z.string().optional().describe("Maximum rows (default 200)"),
      }),
    ),
    response: {
      200: { description: "Checkpoints, newest first", ...toJsonSchema(CheckpointListResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  verify: {
    summary: "Request an independent verification of a checkpoint",
    description:
      "Spawns a verifier INSIDE an evidence-only envelope (empty write list, reads restricted to the tools " +
      "that reach the cited evidence, objects pinned to the refs themselves) and files the verdict as a " +
      "durable VerificationDecision. Deliberately not automatic: a handoff does not wake a verifier, so this " +
      "is a judgment a lead makes about work it delegated. A deployment with no verifier runtime gets a 400 " +
      "saying verification is a human act there — never a silent pass. Gate: agents:write.",
    tags: ["checkpoint"],
    params: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    body: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          maxLength: 600,
          description:
            "Where the verifier should look — a hint, not an instruction. What 'verified' means, how a contradiction is handled, what insufficient evidence answers, and that nothing may be inferred beyond the evidence are the platform's rules and are not settable from here.",
        },
      },
    },
    response: {
      200: { description: "The filed verification decision", type: "object" },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  get: {
    summary: "Read one handoff checkpoint",
    description:
      "The full state transfer: confirmed facts with their evidence references, hypotheses, actions taken, " +
      "open decisions, remaining tasks, the validation plan and (when the envelope demanded one) the " +
      "rollback plan. Requires agents:read; another workspace's checkpoint reads 404.",
    tags: ["checkpoint"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: {
      200: { description: "The checkpoint", ...toJsonSchema(CheckpointResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
};
