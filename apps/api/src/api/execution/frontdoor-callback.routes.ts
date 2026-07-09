import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { frontdoorCallbackDocs } from "./frontdoor-callback.docs.js";

// inbound front-door completion callback — public route; the unguessable runId is the capability (webhook convention).
export function registerFrontdoorCallbackRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // Inbound receiver for the front-door callback completion model (C2b) — the agent POSTs its terminal result to {{callback_url}}=/frontdoor-callback/:runId.
  // Public route: the runId (UUID) is an unguessable capability — no separate auth, possession = permission (webhook convention). Delivering to the rendezvous wakes the waiting dispatch.
  app.post("/frontdoor-callback/:runId", { schema: frontdoorCallbackDocs.deliver }, async (req, reply) => {
    if (!deps.callbackSink) return reply.code(404).send({ code: "NOT_FOUND", message: "callback receiver disabled" });
    const params = z.object({ runId: z.string().min(1) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: "BAD_REQUEST", message: params.error.message });
    deps.callbackSink.deliver(params.data.runId, req.body);
    return reply.send({ ok: true });
  });

  // Current Principal — the web/agent checks workspace·roles (UI gating, etc.).
}
