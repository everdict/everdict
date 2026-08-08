import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { productDocs } from "./product.docs.js";
import { CreateProductBodySchema } from "./request/create-product.js";
import { CreateReleaseBodySchema, UpdateReleaseBodySchema } from "./request/create-release.js";
import { SetReleaseStatusBodySchema } from "./request/set-release-status.js";
import { UpdateProductBodySchema } from "./request/update-product.js";

// The product timeline (docs/architecture/product-timeline.md) — the "what we ship" axis: a product's real
// service composition (GitHub releases/tags pulled into the ledger), the watch series its quality is judged
// by, and gated releases on top. Authz reuses the ISSUE pair (issues:read / issues:write) — the timeline is
// the same planning workflow the tracker carries, one axis over. Delete additionally requires
// creator-or-admin (decided in the service).
export function registerProductRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/products", { schema: productDocs.create }, async (req, reply) => {
    if (!deps.productService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "product service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof CreateProductBodySchema>;
    try {
      body = CreateProductBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.code(201).send(
        await deps.productService.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          name: body.name,
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.icon !== undefined ? { icon: body.icon } : {}),
          ...(body.services !== undefined ? { services: body.services } : {}),
          ...(body.series !== undefined ? { series: body.series } : {}),
          ...(body.autoEval !== undefined ? { autoEval: body.autoEval } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/products", { schema: productDocs.list }, async (req, reply) => {
    if (!deps.productService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "product service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:read");
      return reply.send(await deps.productService.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/products/:id", { schema: productDocs.get }, async (req, reply) => {
    if (!deps.productService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "product service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:read");
      return reply.send(await deps.productService.detail(principal.workspace, req.params.id));
    } catch (err) {
      return sendError(reply, err); // another workspace's id → 404 (tenant-scoped store, no existence leak)
    }
  });

  app.get<{ Params: { id: string } }>(
    "/products/:id/versions",
    { schema: productDocs.listVersions },
    async (req, reply) => {
      if (!deps.productService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "product service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "issues:read");
      } catch (err) {
        return sendError(reply, err);
      }
      const query = z
        .object({
          service: z.string().optional(),
          limit: z.coerce.number().int().positive().max(500).optional(),
        })
        .safeParse(req.query);
      if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
      try {
        return reply.send(await deps.productService.listVersions(principal.workspace, req.params.id, query.data));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // The product's time axis in one read — releases + windowed versions + series points + issue markers. The
  // web draws it; nothing here is derived client-side (the pulse's treatment).
  app.get<{ Params: { id: string } }>(
    "/products/:id/timeline",
    { schema: productDocs.timeline },
    async (req, reply) => {
      if (!deps.productService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "product service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "issues:read");
      } catch (err) {
        return sendError(reply, err);
      }
      const query = z
        .object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() })
        .safeParse(req.query);
      if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
      try {
        return reply.send(await deps.productService.timeline(principal.workspace, req.params.id, query.data));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.patch<{ Params: { id: string } }>("/products/:id", { schema: productDocs.update }, async (req, reply) => {
    if (!deps.productService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "product service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof UpdateProductBodySchema>;
    try {
      body = UpdateProductBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.send(
        await deps.productService.update(principal.workspace, req.params.id, body, { subject: principal.subject }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/products/:id", { schema: productDocs.delete }, async (req, reply) => {
    if (!deps.productService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "product service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      await deps.productService.remove(principal.workspace, req.params.id, {
        subject: principal.subject,
        isAdmin: principal.roles.includes("admin"),
      }); // 404 if not found; non-creator non-admin → 403; releases + ledger cascade with the product
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Pull the tracked services' releases/tags from GitHub NOW — everdict stays the client (no webhook), so
  // this is the timeline's refresh, and a genuinely new version is what fans the watch series out.
  app.post<{ Params: { id: string } }>("/products/:id/sync", { schema: productDocs.sync }, async (req, reply) => {
    if (!deps.productVersionSync)
      return reply.code(404).send({ code: "NOT_FOUND", message: "product sync not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
      return reply.send(
        await deps.productVersionSync.sync(principal.workspace, req.params.id, {
          subject: principal.subject,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- Releases ---------------------------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    "/products/:id/releases",
    { schema: productDocs.createRelease },
    async (req, reply) => {
      if (!deps.productService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "product service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "issues:write");
      } catch (err) {
        return sendError(reply, err);
      }
      let body: z.infer<typeof CreateReleaseBodySchema>;
      try {
        body = CreateReleaseBodySchema.parse(req.body);
      } catch (err) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
      }
      try {
        return reply.code(201).send(
          await deps.productService.createRelease({
            tenant: principal.workspace,
            createdBy: principal.subject,
            productId: req.params.id,
            name: body.name,
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.targetDate !== undefined ? { targetDate: body.targetDate } : {}),
            ...(body.seriesKeys !== undefined ? { seriesKeys: body.seriesKeys } : {}),
          }),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Detail carries the readiness read — open linked issues + every watched series against its baseline. It is
  // a fan-out, which is why the product detail's release list never serves it.
  app.get<{ Params: { id: string } }>("/releases/:id", { schema: productDocs.getRelease }, async (req, reply) => {
    if (!deps.productService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "product service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:read");
      return reply.send(await deps.productService.releaseDetail(principal.workspace, req.params.id));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>("/releases/:id", { schema: productDocs.updateRelease }, async (req, reply) => {
    if (!deps.productService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "product service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof UpdateReleaseBodySchema>;
    try {
      body = UpdateReleaseBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.send(
        await deps.productService.updateRelease(principal.workspace, req.params.id, body, {
          subject: principal.subject,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/releases/:id/status",
    { schema: productDocs.setReleaseStatus },
    async (req, reply) => {
      if (!deps.productService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "product service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "issues:write");
      } catch (err) {
        return sendError(reply, err);
      }
      let body: z.infer<typeof SetReleaseStatusBodySchema>;
      try {
        body = SetReleaseStatusBodySchema.parse(req.body);
      } catch (err) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
      }
      try {
        return reply.send(
          await deps.productService.setReleaseStatus(
            principal.workspace,
            req.params.id,
            { status: body.status, ...(body.force !== undefined ? { force: body.force } : {}) },
            { subject: principal.subject },
          ),
        );
      } catch (err) {
        return sendError(reply, err); // the release gate's refusal is the domain's 409, verbatim
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/releases/:id", { schema: productDocs.deleteRelease }, async (req, reply) => {
    if (!deps.productService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "product service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      await deps.productService.removeRelease(principal.workspace, req.params.id, {
        subject: principal.subject,
        isAdmin: principal.roles.includes("admin"),
      });
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
