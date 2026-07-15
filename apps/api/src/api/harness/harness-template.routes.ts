import { HarnessTemplateSpecSchema } from "@everdict/contracts";
import { checkPortability } from "@everdict/domain";
import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { harnessTemplateDocs } from "./harness-template.docs.js";

// harness templates (category: structure/slots, versions unpinned) — the /harness-templates surface.
// Harnesses are collaborative content → both define and register are ungated (viewer+). Reads are viewer+ too.
export function registerHarnessTemplateRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/harness-templates", { schema: harnessTemplateDocs.register }, async (req, reply) => {
    if (!deps.harnessTemplates)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = HarnessTemplateSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      gate(principal, "templates:write");
      await deps.harnessTemplates.register(principal.workspace, parsed.data, principal.subject);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/harness-templates/validate", { schema: harnessTemplateDocs.validate }, async (req, reply) => {
    if (!deps.harnessTemplates)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "templates:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = HarnessTemplateSpecSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ ok: false, errors: zodIssues(parsed.error), existingVersions: [], versionExists: false });
    const existingVersions = await deps.harnessTemplates.ownVersions(principal.workspace, parsed.data.id);
    // Portability lint runs on the template STRUCTURE (addressing is image-agnostic), so a non-portable topology
    // surfaces at authoring time — anchored to the offending service/field — instead of only failing later at
    // instance resolution (by which point the template is already an immutable version). Non-blocking for the
    // template (the hard block stays at instance register); the wizard renders errors/warnings inline.
    const portabilityIssues = parsed.data.kind === "service" ? checkPortability(parsed.data) : [];
    return reply.send({
      ok: true,
      kind: parsed.data.kind,
      id: parsed.data.id,
      version: parsed.data.version,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
      ...(portabilityIssues.length > 0 ? { portabilityIssues } : {}),
    });
  });

  app.get("/harness-templates", { schema: harnessTemplateDocs.list }, async (req, reply) => {
    if (!deps.harnessTemplates)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      return reply.send(await deps.harnessTemplates.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/harness-templates/:id",
    { schema: harnessTemplateDocs.versions },
    async (req, reply) => {
      if (!deps.harnessTemplates)
        return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "harnesses:read");
        const versions = await deps.harnessTemplates.versions(principal.workspace, req.params.id);
        if (versions.length === 0) return reply.code(404).send({ code: "NOT_FOUND", message: "template not found." });
        return reply.send({ id: req.params.id, versions });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // A single template (category) structure spec — for the detail-view config panel + new-version edit prefill.
  app.get<{ Params: { id: string; version: string } }>(
    "/harness-templates/:id/:version",
    { schema: harnessTemplateDocs.get },
    async (req, reply) => {
      if (!deps.harnessTemplates)
        return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "harnesses:read");
        return reply.send(await deps.harnessTemplates.get(principal.workspace, req.params.id, req.params.version));
      } catch (err) {
        return sendError(reply, err); // missing id/version → 404
      }
    },
  );
}
