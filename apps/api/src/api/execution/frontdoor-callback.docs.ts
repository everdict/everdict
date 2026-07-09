import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CallbackAckResponseSchema } from "./response/callback-ack.js";

// OpenAPI descriptors for the inbound front-door callback route — documentation only (no-op compilers;
// rule api-layer). Attached by frontdoor-callback.routes.ts as { schema: frontdoorCallbackDocs.<key> }.
const docs = {
  deliver: {
    summary: "Deliver a front-door completion callback",
    description:
      "Inbound receiver for the front-door callback completion model: the agent POSTs its terminal result to " +
      "{{callback_url}} (= this route). PUBLIC route — the unguessable runId (UUID) is the capability; " +
      "possession = permission (webhook convention), no Authorization header. Delivering wakes the dispatch " +
      "waiting at the rendezvous. 404 when the callback receiver is disabled.",
    tags: ["execution"],
    params: toJsonSchema(z.object({ runId: z.string().describe("The run's unguessable callback capability") })),
    body: {
      type: "object",
      additionalProperties: true,
      description: "The agent's terminal result payload — delivered to the rendezvous verbatim, not validated here",
    },
    response: {
      200: { description: "Payload delivered", ...toJsonSchema(CallbackAckResponseSchema) },
      ...errorResponses(400, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Export widened to FastifySchema: literal response-status keys would otherwise constrain reply.code()
// in the handlers (doc-only — the schema must never change route typing/behavior).
export const frontdoorCallbackDocs: Record<keyof typeof docs, FastifySchema> = docs;
