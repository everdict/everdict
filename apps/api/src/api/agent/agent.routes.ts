import { deleteAgentVersion, deleteAgentVersions, firstPartyDefaults } from "@everdict/application-control";
import { AgentSpecSchema } from "@everdict/contracts";
import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, teamForNew, zodIssues } from "../route-context.js";
import { agentDocs } from "./agent.docs.js";
import { DeleteAgentVersionsBodySchema } from "./request/delete-agent-versions.js";
import { SaveAgentBodySchema } from "./request/save-agent.js";

// agents (workspace-owned SSOT, the conversational agent's configuration: instructions + MCP tool servers + model)
export function registerAgentRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/agents", { schema: agentDocs.register }, async (req, reply) => {
    if (!deps.agentRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "agent registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    // 새 자산의 소유 팀을 먼저 정하고 그 팀으로 게이트한다 — 등록은 "이 팀 것으로 만든다"이므로,
    // 속하지 않은 팀 앞으로 등록하는 것도 남의 팀 자산을 고치는 것과 같은 거절 사유다.
    let owner: Awaited<ReturnType<typeof teamForNew>>;
    try {
      // 팀 ref 해석(id 또는 key)이 여기서 일어난다 — 없는 팀은 404 이고, 그 답도 게이트와 같은 자리에서 나가야 한다.
      owner = await teamForNew(principal, deps, (req.body as { teamId?: string } | undefined)?.teamId);
      gate(principal, "agents:write", owner.gate);
    } catch (err) {
      return sendError(reply, err); // no permission 403 (gate before validation)
    }
    const parsed = AgentSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.agentRegistry.register(principal.workspace, parsed.data, principal.subject, owner.teamId); // creator = subject (delete rights)
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // immutable 409
    }
  });

  // dry-run validate — schema + this workspace's existing versions/conflict + referenced mcpServers[].authSecret existence (does not register).
  app.post("/agents/validate", { schema: agentDocs.validate }, async (req, reply) => {
    if (!deps.agentRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "agent registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "agents:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = AgentSpecSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ ok: false, errors: zodIssues(parsed.error), existingVersions: [], versionExists: false });
    const existingVersions = await deps.agentRegistry.ownVersions(principal.workspace, parsed.data.id);
    // Referenced-secret existence check (warning): any mcpServers[].authSecret NAME not yet present in this workspace's
    // SecretStore. Surfaces before registration what would otherwise fail only when the agent connects — not a hard failure.
    let missingSecrets: string[] | undefined;
    if (deps.secretStore) {
      const referenced = [...new Set(parsed.data.mcpServers.flatMap((s) => (s.authSecret ? [s.authSecret] : [])))];
      if (referenced.length > 0) {
        const have = new Set((await deps.secretStore.list(principal.workspace)).map((s) => s.name));
        missingSecrets = referenced.filter((name) => !have.has(name));
      }
    }
    return reply.send({
      ok: true,
      id: parsed.data.id,
      version: parsed.data.version,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
      ...(missingSecrets ? { missingSecrets } : {}),
    });
  });

  // Human "save" upsert (the version-free path the web uses). A new id registers 1.0.0; a changed spec auto patch-bumps
  // to a NEW immutable version (so `latest` moves); an unchanged spec is an idempotent no-op (created:false).
  // agents:write (member+). POST /agents stays the explicit-version programmatic path.
  app.put<{ Params: { id: string } }>("/agents/:id", { schema: agentDocs.save }, async (req, reply) => {
    if (!deps.agentService) return reply.code(404).send({ code: "NOT_FOUND", message: "agent service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "agents:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = SaveAgentBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(
        await deps.agentService.saveAgent(principal.workspace, principal.subject, req.params.id, parsed.data),
      );
    } catch (err) {
      return sendError(reply, err); // immutable conflict (concurrent same-version write) → 409
    }
  });

  // The built-in (first-party) default tools catalog — for the Settings › Agent built-in-tools toggles. Workspace-
  // agnostic (the same set for everyone); a workspace opts out via AgentSpec.disabledDefaults. Static route — must be
  // registered before "/agents/:id/versions/:version" is irrelevant (distinct shape), but kept with the other reads.
  app.get("/agents/defaults", { schema: agentDocs.defaults }, async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "agents:read");
      return reply.send({
        defaults: firstPartyDefaults().map((d) => ({
          id: d.record.id,
          name: d.record.name,
          description: d.record.description,
          ...(d.requires ? { requires: d.requires } : {}),
        })),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/agents", { schema: agentDocs.list }, async (req, reply) => {
    if (!deps.agentRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "agent registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "agents:read");
      return reply.send(await deps.agentRegistry.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Full AgentSpec for a specific version. version may be "latest". Other workspace → NOT_FOUND.
  app.get<{ Params: { id: string; version: string } }>(
    "/agents/:id/versions/:version",
    { schema: agentDocs.get },
    async (req, reply) => {
      if (!deps.agentRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "agent registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "agents:read");
        return reply.send(await deps.agentRegistry.get(principal.workspace, req.params.id, req.params.version));
      } catch (err) {
        return sendError(reply, err); // not found → NotFoundError → 404
      }
    },
  );

  // Soft-delete an agent version — only that version's own creator or a workspace admin (deleteAgentVersion gates it).
  app.delete<{ Params: { id: string; version: string } }>(
    "/agents/:id/versions/:version",
    { schema: agentDocs.deleteVersion },
    async (req, reply) => {
      if (!deps.agentRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "agent registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        return reply.send(await deleteAgentVersion(deps.agentRegistry, principal, req.params.id, req.params.version));
      } catch (err) {
        return sendError(reply, err); // no permission 403 / not found 404
      }
    },
  );

  // Bulk soft-delete — several selected versions (body `{versions}`) or the whole agent (body-less = all own live versions).
  app.delete<{ Params: { id: string }; Body: { versions?: string[] } }>(
    "/agents/:id",
    { schema: agentDocs.deleteVersions },
    async (req, reply) => {
      if (!deps.agentRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "agent registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const parsed = DeleteAgentVersionsBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
      try {
        return reply.send(
          await deleteAgentVersions(deps.agentRegistry, principal, req.params.id, parsed.data.versions),
        );
      } catch (err) {
        return sendError(reply, err); // no permission 403 / not found 404
      }
    },
  );
}
