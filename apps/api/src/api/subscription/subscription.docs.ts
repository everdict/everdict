import { SubscriptionRecordSchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CreateSubscriptionBodySchema } from "./request/create-subscription.js";
import { UpdateSubscriptionBodySchema } from "./request/update-subscription.js";

// OpenAPI descriptors for the subscription registry (event-plumbing.md E3 §6) — doc-only, never
// validates/serializes (see api/openapi.ts). A subscription turns a platform fact into a reaction:
// selector (kinds + payload filters) → reaction (agent | webhook | workflow) under governance
// (enabled + cooldown). Authz reuses the agent actions (no new action): read = agents:read,
// write = agents:write; edit/delete additionally require creator-or-admin (decided in the service).
export const subscriptionDocs: Record<"create" | "list" | "update" | "delete", FastifySchema> = {
  create: {
    summary: "Create a subscription",
    description:
      "Requires agents:write. selector.kinds come from the trigger-matchable vocabulary; reaction is " +
      "agent (wake one crafted agent), webhook (signed POST of the fact), or workflow (the durable " +
      "multi-step reaction executor). Reactions naming an agent are validated against the tenant registry.",
    tags: ["subscription"],
    body: toJsonSchema(CreateSubscriptionBodySchema),
    response: {
      201: { description: "Created subscription", ...toJsonSchema(SubscriptionRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  list: {
    summary: "List subscriptions",
    description: "Every subscription in the workspace (small config set, unpaginated). Requires agents:read.",
    tags: ["subscription"],
    response: {
      200: { description: "Workspace subscriptions", ...toJsonSchema(z.array(SubscriptionRecordSchema)) },
      ...errorResponses(401, 403, 404),
    },
  },
  update: {
    summary: "Update a subscription",
    description:
      "Change name/selector/reaction/governance — a present block replaces the stored one whole. " +
      "Requires agents:write; creator or workspace admin only.",
    tags: ["subscription"],
    params: toJsonSchema(z.object({ id: z.string() })),
    body: toJsonSchema(UpdateSubscriptionBodySchema),
    response: {
      200: { description: "Updated subscription", ...toJsonSchema(SubscriptionRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  delete: {
    summary: "Delete a subscription",
    description: "Requires agents:write; creator or workspace admin only. Another workspace's id reads 404.",
    tags: ["subscription"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: {
      204: { description: "Deleted", type: "null" },
      ...errorResponses(401, 403, 404),
    },
  },
};
