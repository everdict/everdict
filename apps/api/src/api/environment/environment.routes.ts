import { VersionTagsBodySchema, setVersionTags } from "@everdict/application-control";
import { EnvironmentSpecSchema } from "@everdict/contracts";
import { imageWarnings } from "@everdict/domain";
import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { environmentDocs } from "./environment.docs.js";

// environments (workspace-owned SSOT: the world a case ACTS ON — harness-definability-spec.md §2).
//
// The gate REUSES `datasets:read`/`datasets:write` rather than minting an action pair, for the reason views
// reuse the scorecard pair: an environment is part of what an evaluation ASKS — the seed repository, the
// fixture, the deployed app a case is posed against — and whoever may author the cases may author the world
// they run in. A new action would have to be granted to every role that already has the dataset one.
export function registerEnvironmentRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const missing = "environment registry not configured";

  app.post("/environments", { schema: environmentDocs.register }, async (req, reply) => {
    if (!deps.environmentRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: missing });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = EnvironmentSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.environmentRegistry.register(principal.workspace, parsed.data, principal.subject);
      // The world's bytes get the same advice every other image-bearing door gives (harness register, a
      // capability save): unqualified or local-only refs run on a self-hosted runner and nowhere else.
      const warnings =
        parsed.data.image !== undefined
          ? imageWarnings([parsed.data.image], await deps.imageRegistryService?.coordinates(principal.workspace))
          : [];
      return reply.code(201).send({
        workspace: principal.workspace,
        id: parsed.data.id,
        version: parsed.data.version,
        ...(warnings.length > 0 ? { imageWarnings: warnings } : {}),
      });
    } catch (err) {
      return sendError(reply, err); // immutable 409
    }
  });

  app.get("/environments", { schema: environmentDocs.list }, async (req, reply) => {
    if (!deps.environmentRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: missing });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:read");
      const entries = await deps.environmentRegistry.list(principal.workspace);
      return reply.send(entries);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string; version: string } }>(
    "/environments/:id/versions/:version",
    { schema: environmentDocs.get },
    async (req, reply) => {
      if (!deps.environmentRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: missing });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "datasets:read");
        return reply.send(await deps.environmentRegistry.get(principal.workspace, req.params.id, req.params.version));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put<{ Params: { id: string; version: string } }>(
    "/environments/:id/versions/:version/tags",
    { schema: environmentDocs.setVersionTags },
    async (req, reply) => {
      if (!deps.environmentRegistry) return reply.code(404).send({ code: "NOT_FOUND", message: missing });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const parsed = VersionTagsBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
      try {
        return reply.send(
          await setVersionTags(
            deps.environmentRegistry,
            principal,
            "datasets:write",
            req.params.id,
            req.params.version,
            parsed.data.tags,
          ),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
