import { IssueLabelColorSchema } from "@everdict/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { issueLabelDocs } from "./issue-label.docs.js";

// The eval tracker's LABEL REGISTRY (docs/tracker.md) — the workspace vocabulary an issue's `labelIds` point at.
// Authz reuses the tracker's one action pair (issues:read / issues:write); a label is not a separate permission
// surface, it is part of classifying issues.
//
// A sub-resource of the issue domain, so it lives in `api/issue/` rather than growing a folder of its own.

const CreateIssueLabelBodySchema = z.object({
  name: z.string().min(1).max(64),
  color: IssueLabelColorSchema,
  description: z.string().max(500).optional(),
});

const UpdateIssueLabelBodySchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    color: IssueLabelColorSchema.optional(),
    description: z.string().max(500).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to update.");

export function registerIssueLabelRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/issue-labels", { schema: issueLabelDocs.list }, async (req, reply) => {
    if (!deps.issueLabelService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "issue label service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:read");
      return reply.send(await deps.issueLabelService.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/issue-labels", { schema: issueLabelDocs.create }, async (req, reply) => {
    if (!deps.issueLabelService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "issue label service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = CreateIssueLabelBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.code(201).send(
        await deps.issueLabelService.create(
          {
            tenant: principal.workspace,
            name: parsed.data.name,
            color: parsed.data.color,
            ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
          },
          { subject: principal.subject },
        ),
      );
    } catch (err) {
      return sendError(reply, err); // a duplicate name is the store's ConflictError → 409
    }
  });

  app.patch<{ Params: { id: string } }>("/issue-labels/:id", { schema: issueLabelDocs.update }, async (req, reply) => {
    if (!deps.issueLabelService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "issue label service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = UpdateIssueLabelBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(
        await deps.issueLabelService.update(principal.workspace, req.params.id, parsed.data, {
          subject: principal.subject,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Deleting strips the label off every issue that wears it, in the store's own transaction. The count is on the
  // read side (`usage`) so a UI can warn before it happens rather than after.
  app.delete<{ Params: { id: string } }>("/issue-labels/:id", { schema: issueLabelDocs.remove }, async (req, reply) => {
    if (!deps.issueLabelService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "issue label service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
      await deps.issueLabelService.remove(principal.workspace, req.params.id, { subject: principal.subject });
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/issue-labels/:id/usage",
    { schema: issueLabelDocs.usage },
    async (req, reply) => {
      if (!deps.issueLabelService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "issue label service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "issues:read");
        return reply.send({ issues: await deps.issueLabelService.usageCount(principal.workspace, req.params.id) });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
