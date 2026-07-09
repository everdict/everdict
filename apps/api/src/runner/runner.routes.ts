import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { PairRunnerBodySchema } from "./runner-service.js";

// self-hosted runners (personal device pairing — self-scoped like profile/connections, no role gate).
export function registerRunnerRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- runners (self-hosted runners; personal device pairing — self-scoped like profile/connections, no role gate) ---
  app.get("/runners", async (req, reply) => {
    if (!deps.runnerService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runner service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      // Personal-owned — list only the subject's own runners, no role gate.
      return reply.send({ runners: await deps.runnerService.list(principal.subject) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Device pairing — the plaintext token (rnr_…) is exposed in the response only once and never again (stored as a hash). The everdict runner authenticates with it.
  app.post("/runners", async (req, reply) => {
    if (!deps.runnerService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runner service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = PairRunnerBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      // Personal-owned: owner=subject. workspace records the paired workspace (for the roster/visibility).
      const paired = await deps.runnerService.pair({
        owner: principal.subject,
        workspace: principal.workspace,
        label: body.data.label,
        ...(body.data.os !== undefined ? { os: body.data.os } : {}),
        ...(body.data.capabilities !== undefined ? { capabilities: body.data.capabilities } : {}),
      });
      return reply.send({ runner: paired.meta, token: paired.token });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/runners/:id", async (req, reply) => {
    if (!deps.runnerService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runner service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      // Personal-owned — revoke only the subject's own runners, no role gate.
      await deps.runnerService.revoke(principal.subject, req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
