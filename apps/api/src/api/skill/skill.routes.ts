import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { CreateSkillBodySchema } from "./request/create-skill.js";
import { GenerateSkillBodySchema } from "./request/generate-skill.js";
import { UpdateSkillBodySchema } from "./request/update-skill.js";
import { skillDocs } from "./skill.docs.js";

// Workspace Skills — SKILL.md-style procedures the members author for the conversational agent. Dual-scoped
// (`private` personal draft / `workspace` shared). Read = skills:read (viewer+); author/edit/share/delete =
// skills:write (member+) PLUS the service's per-visibility manage gate (private = creator-only 404, workspace =
// creator-or-admin 403). Generation (skill-generate) drafts a skill from a description via the workspace's model.
export function registerSkillRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/skills", { schema: skillDocs.create }, async (req, reply) => {
    if (!deps.skillService) return reply.code(404).send({ code: "NOT_FOUND", message: "skills not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "skills:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = CreateSkillBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(
        await deps.skillService.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          name: parsed.data.name,
          description: parsed.data.description,
          instructions: parsed.data.instructions,
          ...(parsed.data.visibility ? { visibility: parsed.data.visibility } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/skills", { schema: skillDocs.list }, async (req, reply) => {
    if (!deps.skillService) return reply.code(404).send({ code: "NOT_FOUND", message: "skills not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "skills:read");
      return reply.send(await deps.skillService.list(principal.workspace, principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/skills/:id", { schema: skillDocs.get }, async (req, reply) => {
    if (!deps.skillService) return reply.code(404).send({ code: "NOT_FOUND", message: "skills not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "skills:read");
      return reply.send(await deps.skillService.get(principal.workspace, req.params.id, principal.subject));
    } catch (err) {
      return sendError(reply, err); // not visible / missing → 404
    }
  });

  app.patch<{ Params: { id: string } }>("/skills/:id", { schema: skillDocs.update }, async (req, reply) => {
    if (!deps.skillService) return reply.code(404).send({ code: "NOT_FOUND", message: "skills not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "skills:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = UpdateSkillBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(
        await deps.skillService.update(principal.workspace, req.params.id, parsed.data, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        }),
      );
    } catch (err) {
      return sendError(reply, err); // creator-or-admin gate → 403/404
    }
  });

  app.delete<{ Params: { id: string } }>("/skills/:id", { schema: skillDocs.remove }, async (req, reply) => {
    if (!deps.skillService) return reply.code(404).send({ code: "NOT_FOUND", message: "skills not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "skills:write");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      await deps.skillService.remove(principal.workspace, req.params.id, {
        subject: principal.subject,
        isAdmin: principal.roles.includes("admin"),
      });
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // skill-generate — draft a skill (name + description + instructions) from a description via the workspace's model.
  // Nothing is persisted; the member edits the draft and saves via POST /skills. skills:write (a real billable call).
  app.post("/skills/generate", { schema: skillDocs.generate }, async (req, reply) => {
    if (!deps.skillGenerator)
      return reply.code(404).send({ code: "NOT_FOUND", message: "skill generation not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "skills:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = GenerateSkillBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(await deps.skillGenerator.generate(principal.workspace, principal.subject, parsed.data));
    } catch (err) {
      return sendError(reply, err); // unknown model 404 / missing key 400 / upstream error
    }
  });
}
