import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { type ServerDeps, resolvePrincipal, sendError } from "../route-context.js";
import { browserProfileDocs } from "./browser-profile.docs.js";
import { CreateBrowserProfileBodySchema } from "./request/create-browser-profile.js";
import { UpdateBrowserProfileBodySchema } from "./request/update-browser-profile.js";

// Saved authenticated browser profiles (browser-profiles S2) — personal / self-scoped (owner = subject, like
// connected accounts): authenticated, NO role gate; the service enforces owner-only (a cross-owner id 404s, no
// existence leak). See docs/architecture/browser-profiles.md.
export function registerBrowserProfileRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/browser-profiles", { schema: browserProfileDocs.create }, async (req, reply) => {
    if (!deps.browserProfileService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "browser profiles not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    let body: z.infer<typeof CreateBrowserProfileBodySchema>;
    try {
      body = CreateBrowserProfileBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.send(
        await deps.browserProfileService.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          name: body.name,
          ...(body.cookieDomains ? { cookieDomains: body.cookieDomains } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/browser-profiles", { schema: browserProfileDocs.list }, async (req, reply) => {
    if (!deps.browserProfileService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "browser profiles not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      return reply.send(await deps.browserProfileService.list(principal.workspace, principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/browser-profiles/:id",
    { schema: browserProfileDocs.get },
    async (req, reply) => {
      if (!deps.browserProfileService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "browser profiles not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        return reply.send(await deps.browserProfileService.get(principal.workspace, req.params.id, principal.subject));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/browser-profiles/:id",
    { schema: browserProfileDocs.update },
    async (req, reply) => {
      if (!deps.browserProfileService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "browser profiles not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      let body: z.infer<typeof UpdateBrowserProfileBodySchema>;
      try {
        body = UpdateBrowserProfileBodySchema.parse(req.body);
      } catch (err) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
      }
      try {
        return reply.send(
          await deps.browserProfileService.update(principal.workspace, req.params.id, body, principal.subject),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/browser-profiles/:id",
    { schema: browserProfileDocs.remove },
    async (req, reply) => {
      if (!deps.browserProfileService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "browser profiles not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        await deps.browserProfileService.remove(principal.workspace, req.params.id, principal.subject);
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
