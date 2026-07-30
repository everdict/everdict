import { VersionTagsBodySchema } from "@everdict/application-control";
import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { capabilityDocs } from "./capability.docs.js";
import { ProbeCapabilityMcpBodySchema } from "./request/probe-capability-mcp.js";
import { SaveCapabilityBodySchema } from "./request/save-capability.js";
import { SetCapabilityVisibilityBodySchema } from "./request/set-capability-visibility.js";
import { ValidateCapabilityBodySchema } from "./request/validate-capability.js";

// Capability Store — one discriminated versioned entity (mcp|code|skill|environment) members author, publish at a reach tier
// (private|workspace|subset|public), and adopt into their agent. Read = capabilities:read (viewer+); author/publish/
// edit-reach/delete = capabilities:write (member+) PLUS the service's owner-or-admin gate (publishing 'public' needs
// an admin). Cross-tenant reads (subset/public) are authorized by canConsumeCapability in the service.
export function registerCapabilityRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const notConfigured = { code: "NOT_FOUND", message: "capabilities not configured" };
  const actorOf = (principal: { subject: string; roles: string[] }) => ({
    subject: principal.subject,
    isAdmin: principal.roles.includes("admin"),
  });

  app.put<{ Params: { id: string } }>("/capabilities/:id", { schema: capabilityDocs.save }, async (req, reply) => {
    if (!deps.capabilityService) return reply.code(404).send(notConfigured);
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "capabilities:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = SaveCapabilityBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(
        await deps.capabilityService.save(principal.workspace, actorOf(principal), req.params.id, parsed.data),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Dry-run validate — parse the spec + predict the version a save would assign + environment image warnings. Never
  // writes. Static path, registered before the parameterized reads. capabilities:write (member+, same as save).
  app.post("/capabilities/validate", { schema: capabilityDocs.validate }, async (req, reply) => {
    if (!deps.capabilityService) return reply.code(404).send(notConfigured);
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "capabilities:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = ValidateCapabilityBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.send({ ok: false, errors: zodIssues(parsed.error) });
    try {
      const { id, name, description, spec } = parsed.data;
      const result = await deps.capabilityService.validate(principal.workspace, id, { name, description, spec });
      return reply.send({ ok: true, ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Probe an mcp capability URL — test-connect and list its tools (wizard "test connection" + tool discovery). Failure
  // is a result (reachable:false), never a throw. capabilities:write (authoring). 404 when the prober isn't wired.
  app.post("/capabilities/probe-mcp", { schema: capabilityDocs.probeMcp }, async (req, reply) => {
    if (!deps.probeCapabilityMcp) return reply.code(404).send(notConfigured);
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "capabilities:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = ProbeCapabilityMcpBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    return reply.send(
      await deps.probeCapabilityMcp(parsed.data.url, parsed.data.token ? { token: parsed.data.token } : {}),
    );
  });

  app.get("/capabilities", { schema: capabilityDocs.list }, async (req, reply) => {
    if (!deps.capabilityService) return reply.code(404).send(notConfigured);
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "capabilities:read");
      return reply.send(await deps.capabilityService.list(principal.workspace, principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/capabilities/public", { schema: capabilityDocs.listPublic }, async (req, reply) => {
    if (!deps.capabilityService) return reply.code(404).send(notConfigured);
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "capabilities:read");
      return reply.send(await deps.capabilityService.listPublic(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { source?: string } }>(
    "/capabilities/:id",
    { schema: capabilityDocs.get },
    async (req, reply) => {
      if (!deps.capabilityService) return reply.code(404).send(notConfigured);
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "capabilities:read");
        return reply.send(
          await deps.capabilityService.get(
            principal.workspace,
            req.params.id,
            principal.subject,
            "latest",
            req.query.source,
          ),
        );
      } catch (err) {
        return sendError(reply, err); // not visible / missing → 404
      }
    },
  );

  // Live versions + version tags for one capability id — my workspace, or a cross-tenant public/subset owner via
  // `?source=`. Not visible / missing → 404. Static "versions" segment resolves ahead of :version.
  app.get<{ Params: { id: string }; Querystring: { source?: string } }>(
    "/capabilities/:id/versions",
    { schema: capabilityDocs.versions },
    async (req, reply) => {
      if (!deps.capabilityService) return reply.code(404).send(notConfigured);
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "capabilities:read");
        return reply.send(
          await deps.capabilityService.listVersions(
            principal.workspace,
            principal.subject,
            req.params.id,
            req.query.source,
          ),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Structural diff of two versions over the immutable content (name/description/spec). Both refs accept "latest".
  // `?source=` diffs a cross-tenant public/subset owner. Static "diff" segment resolves ahead of :version.
  app.get<{ Params: { id: string }; Querystring: { base?: string; candidate?: string; source?: string } }>(
    "/capabilities/:id/diff",
    { schema: capabilityDocs.diff },
    async (req, reply) => {
      if (!deps.capabilityService) return reply.code(404).send(notConfigured);
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const { base, candidate, source } = req.query;
      if (!base || !candidate)
        return reply
          .code(400)
          .send({ code: "BAD_REQUEST", message: "base and candidate query parameters are required." });
      try {
        gate(principal, "capabilities:read");
        return reply.send(
          await deps.capabilityService.diff(
            principal.workspace,
            principal.subject,
            req.params.id,
            base,
            candidate,
            source,
          ),
        );
      } catch (err) {
        return sendError(reply, err); // version not found / not visible → 404
      }
    },
  );

  app.get<{ Params: { id: string; version: string }; Querystring: { source?: string } }>(
    "/capabilities/:id/versions/:version",
    { schema: capabilityDocs.getVersion },
    async (req, reply) => {
      if (!deps.capabilityService) return reply.code(404).send(notConfigured);
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "capabilities:read");
        return reply.send(
          await deps.capabilityService.get(
            principal.workspace,
            req.params.id,
            principal.subject,
            req.params.version,
            req.query.source,
          ),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Replace a version's tags (whole-array PUT; empty = clear) — mutable metadata outside spec immutability (free labels
  // to tell versions apart). capabilities:write (member+) PLUS the service's creator-or-admin gate. Missing / another
  // workspace's version → 404.
  app.put<{ Params: { id: string; version: string } }>(
    "/capabilities/:id/versions/:version/tags",
    { schema: capabilityDocs.setVersionTags },
    async (req, reply) => {
      if (!deps.capabilityService) return reply.code(404).send(notConfigured);
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "capabilities:write");
      } catch (err) {
        return sendError(reply, err);
      }
      const parsed = VersionTagsBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
      try {
        return reply.send(
          await deps.capabilityService.setVersionTags(
            principal.workspace,
            req.params.id,
            req.params.version,
            parsed.data.tags,
            actorOf(principal),
          ),
        );
      } catch (err) {
        return sendError(reply, err); // creator-or-admin gate → 403/404
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/capabilities/:id/visibility",
    { schema: capabilityDocs.setVisibility },
    async (req, reply) => {
      if (!deps.capabilityService) return reply.code(404).send(notConfigured);
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "capabilities:write");
      } catch (err) {
        return sendError(reply, err);
      }
      const parsed = SetCapabilityVisibilityBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
      try {
        return reply.send(
          await deps.capabilityService.setVisibility(
            principal.workspace,
            req.params.id,
            { visibility: parsed.data.visibility, sharedWith: parsed.data.sharedWith },
            actorOf(principal),
          ),
        );
      } catch (err) {
        return sendError(reply, err); // owner-or-admin / public-admin gate → 403/404
      }
    },
  );

  app.delete<{ Params: { id: string; version: string } }>(
    "/capabilities/:id/versions/:version",
    { schema: capabilityDocs.deleteVersion },
    async (req, reply) => {
      if (!deps.capabilityService) return reply.code(404).send(notConfigured);
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "capabilities:write");
      } catch (err) {
        return sendError(reply, err);
      }
      try {
        await deps.capabilityService.deleteVersion(
          principal.workspace,
          req.params.id,
          req.params.version,
          actorOf(principal),
        );
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err); // creator-or-admin gate → 403/404
      }
    },
  );
}
