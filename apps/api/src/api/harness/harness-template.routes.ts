import { TEAM_TRANSFERABLE_CAPABILITIES, moveCapabilityToTeam } from "@everdict/application-control";
import { HarnessTemplateSpecSchema } from "@everdict/contracts";
import { checkPortability, ownedByVisibleTeam } from "@everdict/domain";
import type { FastifyInstance } from "fastify";
import { assertEntityVisible, visibleTeamsFor } from "../../common/team-scope.js";
import { agentAttributionFrom } from "../fs/fs-actor.js";
import {
  type ServerDeps,
  gate,
  resolvePrincipal,
  resolveTeamRef,
  sendError,
  teamForNew,
  zodIssues,
} from "../route-context.js";
import { MoveToTeamBodySchema } from "../team-move.js";
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
      // Decide the owning team first, then gate against it — registering is "make this the team's", so filing it
      // under a team you are not on is refused for the same reason editing that team's work is. A template that
      // named no team used to land UNOWNED, which made it the one capability the axis could not describe.
      const owner = await teamForNew(principal, deps, (req.body as { teamId?: string } | undefined)?.teamId);
      gate(principal, "templates:write", owner.gate);
      await deps.harnessTemplates.register(principal.workspace, parsed.data, principal.subject, owner.teamId);
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
      // A private team's authored entry is that team's — the ceiling every other team-owned read stays under.
      const seen = await visibleTeamsFor(deps, principal);
      const entries = await deps.harnessTemplates.list(principal.workspace);
      return reply.send(entries.filter((e) => ownedByVisibleTeam(e, seen)));
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
        await assertEntityVisible(
          deps,
          principal,
          deps.harnessTemplates,
          principal.workspace,
          req.params.id,
          "harness template",
        );
        return reply.send(await deps.harnessTemplates.get(principal.workspace, req.params.id, req.params.version));
      } catch (err) {
        return sendError(reply, err); // missing id/version → 404
      }
    },
  );

  // Hand the harness template to another team. A transition, not an edit: it re-files EVERY version at once (ownership
  // belongs to the harness template, not to one release of it) and emits `harness.moved`, so it gets its own endpoint
  // exactly like the issue's team move does. Both teams are authorized inside the service — the one it is
  // leaving and the one it is joining.
  app.post<{ Params: { id: string } }>(
    "/harness-templates/:id/team",
    { schema: harnessTemplateDocs.move },
    async (req, reply) => {
      if (!deps.harnessTemplates)
        return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const body = MoveToTeamBodySchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
      try {
        const agent = agentAttributionFrom(req.headers);
        return reply.send(
          await moveCapabilityToTeam({
            registry: deps.harnessTemplates,
            capability: TEAM_TRANSFERABLE_CAPABILITIES.harnessTemplate,
            principal,
            id: req.params.id,
            // Resolved here (id or key, `ENG`) so an unknown team is a 404 before the gate compares it against the
            // teams the principal carries — which are ids.
            teamId: await resolveTeamRef(deps, principal.workspace, body.data.teamId),
            ...(deps.platformEvents ? { events: deps.platformEvents } : {}),
            ...(agent ? { agent } : {}),
          }),
        );
      } catch (err) {
        return sendError(reply, err); // not on one of the teams 403 / unknown harness template 404 / already there 409
      }
    },
  );
}
