import { ModelSpecSchema } from "@everdict/core";
import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { modelDocs } from "./model.docs.js";

// models (workspace-owned SSOT, inference/judging model: provider + underlying model + baseUrl)
export function registerModelRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/models", { schema: modelDocs.register }, async (req, reply) => {
    if (!deps.modelRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "model registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "models:write");
    } catch (err) {
      return sendError(reply, err); // no permission 403 (gate before validation)
    }
    const parsed = ModelSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.modelRegistry.register(principal.workspace, parsed.data);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // immutable 409
    }
  });

  // dry-run validate — schema + this workspace's existing versions/conflict (does not register).
  app.post("/models/validate", { schema: modelDocs.validate }, async (req, reply) => {
    if (!deps.modelRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "model registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "models:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = ModelSpecSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ ok: false, errors: zodIssues(parsed.error), existingVersions: [], versionExists: false });
    const existingVersions = await deps.modelRegistry.ownVersions(principal.workspace, parsed.data.id);
    return reply.send({
      ok: true,
      provider: parsed.data.provider,
      id: parsed.data.id,
      version: parsed.data.version,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
    });
  });

  app.get("/models", { schema: modelDocs.list }, async (req, reply) => {
    if (!deps.modelRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "model registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "models:read");
      return reply.send(await deps.modelRegistry.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Full ModelSpec for a specific version. version may be "latest". Other workspace → NOT_FOUND.
  app.get<{ Params: { id: string; version: string } }>(
    "/models/:id/versions/:version",
    { schema: modelDocs.get },
    async (req, reply) => {
      if (!deps.modelRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "model registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "models:read");
        return reply.send(await deps.modelRegistry.get(principal.workspace, req.params.id, req.params.version));
      } catch (err) {
        return sendError(reply, err); // not found → NotFoundError → 404
      }
    },
  );
}
