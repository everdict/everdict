import { WorkspaceProxySchema } from "@everdict/contracts";
import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { proxyDocs } from "./proxy.docs.js";

// Workspace BYO egress proxies (browser-profiles S4) — per-country proxy pool for the interactive login browser.
// List is a workspace read (authenticated, no role gate — secrets are redacted; the session geo picker consumes it);
// register/remove are admin (settings:write). See docs/architecture/browser-profiles.md.
export function registerProxyRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/workspace/proxies", { schema: proxyDocs.list }, async (req, reply) => {
    if (!deps.proxyService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "proxies not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      return reply.send({ proxies: await deps.proxyService.list(principal.workspace) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/proxies", { schema: proxyDocs.upsert }, async (req, reply) => {
    if (!deps.proxyService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "proxies not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const body = WorkspaceProxySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      return reply.send(await deps.proxyService.upsert(principal.workspace, body.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { name: string } }>("/workspace/proxies/:name", { schema: proxyDocs.remove }, async (req, reply) => {
    if (!deps.proxyService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "proxies not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      await deps.proxyService.remove(principal.workspace, req.params.name);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
