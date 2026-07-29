import { ApprovalRecordSchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

const approvalIdParams = toJsonSchema(z.object({ id: z.string().describe("Approval id") }));

// OpenAPI descriptors for the durable agent-approval routes (agent-automation A6 — documentation only).
// The public half is the member surface (list pending asks, decide); the internal half is the agent-service
// bridge (park + legacy-channel settle), guarded by x-internal-token like the other internal bridges.
const docs = {
  list: {
    summary: "List agent approvals",
    description:
      "The workspace's parked agent mutations (durable — an ask survives an agent-service restart). " +
      "?status filters (default: all); the bell/fleet read status=pending. Requires agents:read (viewer+).",
    tags: ["approval"],
    querystring: toJsonSchema(
      z.object({
        status: z.enum(["pending", "approved", "denied", "expired"]).optional(),
        sessionId: z.string().optional(),
      }),
    ),
    response: {
      200: { description: "Approvals, newest first", ...toJsonSchema(z.array(ApprovalRecordSchema)) },
      ...errorResponses(401, 403),
    },
  },
  decide: {
    summary: "Decide a parked agent mutation",
    description:
      "Approve or deny the parked ask: the record settles exactly once (a second decision — or deciding an " +
      "expired ask — is a 409; first write wins against the expiry timer), an approval.decided fact rides the " +
      "E0 outbox, and the decision is delivered to the agent's live in-process wait. delivered:false means " +
      "the loop is gone (agent-service restart) — the record still holds the decision for the resume leg. " +
      "Requires agents:write (member+).",
    tags: ["approval"],
    params: approvalIdParams,
    body: toJsonSchema(z.object({ decision: z.enum(["approve", "deny"]) })),
    response: {
      200: {
        description: "The settled record + whether a live wait received it",
        ...toJsonSchema(z.object({ record: ApprovalRecordSchema, delivered: z.boolean() })),
      },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  register: {
    summary: "Park an agent mutation (internal bridge)",
    description:
      "Agent-service → CP: record a parked write-tool ask durably (the A6 park). Guarded by x-internal-token.",
    tags: ["internal"],
    response: {
      201: { description: "The pending approval", ...toJsonSchema(ApprovalRecordSchema) },
      ...errorResponses(400, 403, 404),
    },
  },
  settle: {
    summary: "Settle a park from the agent side (internal bridge)",
    description:
      "Agent-service → CP: the in-process wait resolved through the LEGACY channel (POST /permission) or " +
      "timed out locally — converge the ledger. Already-settled records skip silently (the normal race with " +
      "the CP decide path). Guarded by x-internal-token.",
    tags: ["internal"],
    params: approvalIdParams,
    response: {
      200: { description: "The (possibly already-settled) record", ...toJsonSchema(ApprovalRecordSchema) },
      ...errorResponses(400, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

export const approvalDocs: Record<keyof typeof docs, FastifySchema> = docs;
