import { deleteModelVersion, deleteModelVersions } from "@everdict/application-control";
import { ModelSpecSchema } from "@everdict/contracts";
import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { modelDocs } from "./model.docs.js";
import { DeleteModelVersionsBodySchema } from "./request/delete-model-versions.js";

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
      await deps.modelRegistry.register(principal.workspace, parsed.data, principal.subject); // creator = subject (delete rights)
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
    // Referenced-secret existence check (warning): whether the model's apiKeySecret (the NAME of the key its agent
    // server / judge will use) already exists in this workspace's SecretStore. Surfaces before registration what would
    // otherwise fail only at dispatch — not a hard failure (the secret can be added later).
    let missingSecrets: string[] | undefined;
    if (deps.secretStore && parsed.data.apiKeySecret) {
      const have = new Set((await deps.secretStore.list(principal.workspace)).map((s) => s.name));
      missingSecrets = have.has(parsed.data.apiKeySecret) ? [] : [parsed.data.apiKeySecret];
    }
    return reply.send({
      ok: true,
      provider: parsed.data.provider,
      id: parsed.data.id,
      version: parsed.data.version,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
      ...(missingSecrets ? { missingSecrets } : {}),
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

  // Soft-delete a model version — only that version's own creator or a workspace admin (deleteModelVersion gates it).
  // Deletion is a tombstone (data preserved, excluded from reads) → past scorecards that referenced it stay reproducible. Missing/already-deleted/non-owned version = 404.
  app.delete<{ Params: { id: string; version: string } }>(
    "/models/:id/versions/:version",
    { schema: modelDocs.deleteVersion },
    async (req, reply) => {
      if (!deps.modelRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "model registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        return reply.send(await deleteModelVersion(deps.modelRegistry, principal, req.params.id, req.params.version));
      } catch (err) {
        return sendError(reply, err); // no permission 403 / not found 404
      }
    },
  );

  // Bulk soft-delete — several selected versions (body `{versions}`) or the whole model (body-less = all own live versions).
  // deleteModelVersions gates each target creator-or-admin and fails fast (nothing deleted if any is forbidden/absent).
  app.delete<{ Params: { id: string }; Body: { versions?: string[] } }>(
    "/models/:id",
    { schema: modelDocs.deleteVersions },
    async (req, reply) => {
      if (!deps.modelRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "model registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      // Body is optional (body-less DELETE = delete all). Only validate when one was sent.
      const parsed = DeleteModelVersionsBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
      try {
        return reply.send(
          await deleteModelVersions(deps.modelRegistry, principal, req.params.id, parsed.data.versions),
        );
      } catch (err) {
        return sendError(reply, err); // no permission 403 / not found 404
      }
    },
  );
}
