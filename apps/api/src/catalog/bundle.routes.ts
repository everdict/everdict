import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { BundleSchema, requiredActionsForBundle } from "./bundle-service.js";

// bundles (one-shot bundle apply: register harness+benchmark+dataset+runtime+judge/model from a single manifest)
// authZ = compose and enforce the required per-type gates derived from the bundle contents, with no new action (requiredActionsForBundle).
export function registerBundleRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/bundles/apply", async (req, reply) => {
    if (!deps.bundleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "bundle service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = BundleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      for (const action of requiredActionsForBundle(parsed.data)) gate(principal, action); // per-section gate
      return reply.send(await deps.bundleService.apply(principal.workspace, principal.subject, parsed.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
