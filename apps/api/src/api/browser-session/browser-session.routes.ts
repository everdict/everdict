import type { FastifyInstance } from "fastify";
import { type ServerDeps, resolvePrincipal, sendError } from "../route-context.js";
import { browserSessionDocs } from "./browser-session.docs.js";

// Interactive browser sessions (browser-profiles S1) — a dedicated browser the owner drives live over a WS to log
// into a site. Personal / self-scoped (owner = subject, like connected accounts): authenticated, NO role gate; the
// service enforces owner-only (a cross-owner id 404s, no existence leak). See docs/architecture/browser-profiles.md.
export function registerBrowserSessionRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // Start a session — provisions a dedicated browser and returns its handle (at most one active per owner). An
  // optional { country } selects the workspace's egress proxy for the login browser (browser-profiles S4).
  app.post<{ Body: { country?: string } }>(
    "/browser-sessions",
    { schema: browserSessionDocs.create },
    async (req, reply) => {
      if (!deps.browserSessionService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "browser sessions not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const country = typeof req.body?.country === "string" && req.body.country ? req.body.country : undefined;
      try {
        const session = await deps.browserSessionService.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          ...(country ? { country } : {}),
        });
        return reply.send(session);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // List the caller's own sessions.
  app.get("/browser-sessions", { schema: browserSessionDocs.list }, async (req, reply) => {
    if (!deps.browserSessionService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "browser sessions not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      return reply.send({ sessions: deps.browserSessionService.list(principal.subject) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Get one session the caller owns.
  app.get<{ Params: { id: string } }>(
    "/browser-sessions/:id",
    { schema: browserSessionDocs.get },
    async (req, reply) => {
      if (!deps.browserSessionService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "browser sessions not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        const session = deps.browserSessionService.get(req.params.id, principal.subject);
        if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "browser session not found." });
        return reply.send(session);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Close a session (tear the browser down).
  app.delete<{ Params: { id: string } }>(
    "/browser-sessions/:id",
    { schema: browserSessionDocs.remove },
    async (req, reply) => {
      if (!deps.browserSessionService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "browser sessions not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        await deps.browserSessionService.close(req.params.id, principal.subject);
        return reply.send({ ok: true });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Mint a WS ticket — a browser can't set an Authorization header on a WebSocket, so an authenticated (owner-only)
  // POST mints a short-lived single-use ticket; the browser then opens WS /browser-sessions/:id?ticket=… .
  app.post<{ Params: { id: string } }>(
    "/browser-sessions/:id/ticket",
    { schema: browserSessionDocs.ticket },
    async (req, reply) => {
      if (!deps.browserSessionService || !deps.browserTickets)
        return reply.code(404).send({ code: "NOT_FOUND", message: "browser sessions not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        const owner = deps.browserSessionService.ownerOf(req.params.id);
        if (owner !== principal.subject)
          return reply.code(404).send({ code: "NOT_FOUND", message: "browser session not found." });
        const ticket = deps.browserTickets.issue(req.params.id, principal.subject);
        return reply.send({ ticket });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
