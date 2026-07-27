import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { imageRegistryDocs } from "./image-registry.docs.js";

// workspace image registries (BYO, multiple) — the image-classification baseline + push-credential mint.
export function registerImageRegistryRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- workspace image registries (BYO, multiple) — the harness image-classification baseline + the target for everdict image push ---
  // Register multiple by name and select one at push time (classification/pull-auth match across all hosts). Read harnesses:read (viewer+ —
  // the classification badge is a harness-read concern, the view is a name reference/coordinates only) / register·unregister settings:write / push credentials
  // images:push (member+ — value disclosure named as its own action). Design: docs/architecture/workspace-image-registry.md
  app.get("/workspace/image-registries", { schema: imageRegistryDocs.list }, async (req, reply) => {
    if (!deps.imageRegistryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "image registry service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      return reply.send({ registries: await deps.imageRegistryService.list(principal.workspace) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/image-registries", { schema: imageRegistryDocs.upsert }, async (req, reply) => {
    if (!deps.imageRegistryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "image registry service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({
        name: z.string().min(1), // registry name (reference key)
        host: z.string().min(1), // registry host[:port] — not a URL (no scheme)
        namespace: z.string().min(1).optional(),
        username: z.string().min(1).optional(),
        pullSecretName: z.string().min(1).optional(),
        pushSecretName: z.string().min(1).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write");
      const result = await deps.imageRegistryService.upsert(principal.workspace, body.data);
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete("/workspace/image-registries/:name", { schema: imageRegistryDocs.remove }, async (req, reply) => {
    if (!deps.imageRegistryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "image registry service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { name } = req.params as { name: string };
    try {
      gate(principal, "settings:write");
      await deps.imageRegistryService.remove(principal.workspace, name);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // List a repository's tags (Docker Registry v2) — powers the capability wizard's environment image picker (pick a
  // tag instead of hand-typing a ref) and any "which versions exist" view. Read (harnesses:read). ?registry= selects
  // one when several are registered (omit with exactly one). Upstream failures surface as our AppError (502/etc).
  app.get<{ Querystring: { repository?: string; registry?: string } }>(
    "/workspace/image-registries/tags",
    { schema: imageRegistryDocs.tags },
    async (req, reply) => {
      if (!deps.imageRegistryService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "image registry service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const repository = req.query.repository;
      if (!repository) return reply.code(400).send({ code: "BAD_REQUEST", message: "repository is required" });
      try {
        gate(principal, "harnesses:read");
        return reply.send(
          await deps.imageRegistryService.listTags(principal.workspace, repository, req.query.registry),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Inspect a manifest (tag or digest) — returns the digest (for a digest-pinned ref, the recommended environment
  // pin), media type, and platforms/layer count. Read (harnesses:read). Same registry selection as tags.
  app.get<{ Querystring: { repository?: string; reference?: string; registry?: string } }>(
    "/workspace/image-registries/manifest",
    { schema: imageRegistryDocs.manifest },
    async (req, reply) => {
      if (!deps.imageRegistryService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "image registry service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const { repository, reference } = req.query;
      if (!repository || !reference)
        return reply.code(400).send({ code: "BAD_REQUEST", message: "repository and reference are required" });
      try {
        gate(principal, "harnesses:read");
        return reply.send(
          await deps.imageRegistryService.inspectImage(principal.workspace, repository, reference, req.query.registry),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Mint push credentials — the 'value' of pushSecretName goes out in the response (non-persistent, the caller discards it after docker login+push).
  // Select the registry via ?name= — omitting it is allowed only when there's exactly one (omitting it with multiple → 400, listing the names).
  app.post<{ Querystring: { name?: string } }>(
    "/workspace/image-registries/push-credentials",
    { schema: imageRegistryDocs.pushCredentials },
    async (req, reply) => {
      if (!deps.imageRegistryService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "image registry service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "images:push");
        const credentials = await deps.imageRegistryService.pushCredentials(principal.workspace, req.query.name);
        return reply.send({ credentials });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
