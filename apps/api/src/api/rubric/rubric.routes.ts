import { RubricSpecSchema } from "@everdict/core";
import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";

// rubrics (workspace-owned SSOT, HOW to judge: text and/or criteria + optional prompt template — referenced by judges)
// AuthZ reuses the judge actions (rubrics are the judging domain — no new action, mirroring how views reuse
// scorecards:*): read = judges:read, write = judges:write.
export function registerRubricRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/rubrics", async (req, reply) => {
    if (!deps.rubricRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "rubric registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "judges:write");
    } catch (err) {
      return sendError(reply, err); // no permission 403 (gate before validation)
    }
    const parsed = RubricSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.rubricRegistry.register(principal.workspace, parsed.data, principal.subject);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // immutable 409
    }
  });

  // dry-run validate — schema + this workspace's existing versions/conflict (does not register).
  app.post("/rubrics/validate", async (req, reply) => {
    if (!deps.rubricRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "rubric registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "judges:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = RubricSpecSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ ok: false, errors: zodIssues(parsed.error), existingVersions: [], versionExists: false });
    const existingVersions = await deps.rubricRegistry.ownVersions(principal.workspace, parsed.data.id);
    return reply.send({
      ok: true,
      id: parsed.data.id,
      version: parsed.data.version,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
    });
  });

  app.get("/rubrics", async (req, reply) => {
    if (!deps.rubricRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "rubric registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "judges:read");
      return reply.send(await deps.rubricRegistry.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Full RubricSpec for a specific version. version may be "latest". Other workspace → NOT_FOUND.
  app.get<{ Params: { id: string; version: string } }>("/rubrics/:id/versions/:version", async (req, reply) => {
    if (!deps.rubricRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "rubric registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "judges:read");
      return reply.send(await deps.rubricRegistry.get(principal.workspace, req.params.id, req.params.version));
    } catch (err) {
      return sendError(reply, err); // not found → NotFoundError → 404
    }
  });
}
