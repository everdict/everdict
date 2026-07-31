import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { agentToolDocs } from "./agent-tool.docs.js";
import { BindAgentToolSecretsBodySchema } from "./request/bind-agent-tool-secrets.js";
import { SetAgentToolBodySchema } from "./request/set-agent-tool.js";

// /agent/tools + /agent/skills — the CALLER's own agent (Settings › Agent › Tools and › Skills). Self-scoped like
// personal secrets: a member reads and configures only their own overlay, so there is no role gate beyond being a
// member of the workspace (the workspace-wide baseline is the AgentSpec + the skill library, which stay gated).
// Two members configuring different sets is the point — the agent answers each of them with their own.
export function registerAgentToolRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/agent/tools", { schema: agentToolDocs.listTools }, async (req, reply) => {
    if (!deps.agentMemberToolingService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "agent tooling service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      return reply.send(await deps.agentMemberToolingService.listTools(principal.workspace, principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/agent/tools", { schema: agentToolDocs.setTool }, async (req, reply) => {
    if (!deps.agentMemberToolingService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "agent tooling service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = SetAgentToolBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(
        await deps.agentMemberToolingService.setTool(
          principal.workspace,
          principal.subject,
          parsed.data.key,
          parsed.data.enabled,
        ),
      );
    } catch (err) {
      return sendError(reply, err); // an unknown/foreign key is 404 (no existence leak)
    }
  });

  // ONE tool in full — the detail behind the switch (transport · functions · description · secrets · source). The key
  // carries `:` and `/` (capability:<owner>/<id>), so callers percent-encode it into the segment.
  app.get<{ Params: { key: string } }>("/agent/tools/:key", { schema: agentToolDocs.getTool }, async (req, reply) => {
    if (!deps.agentMemberToolingService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "agent tooling service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      return reply.send(
        await deps.agentMemberToolingService.getTool(principal.workspace, principal.subject, req.params.key),
      );
    } catch (err) {
      return sendError(reply, err); // not in the caller's toolset → 404 (no existence leak)
    }
  });

  // Live connect to an HTTP MCP tool with the caller's own bound secret and list what it really serves. Unreachable is
  // a 200 result (reachable:false); only "this tool cannot be probed at all" is a 400.
  app.post<{ Params: { key: string } }>(
    "/agent/tools/:key/probe",
    { schema: agentToolDocs.probeTool },
    async (req, reply) => {
      if (!deps.agentMemberToolingService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "agent tooling service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        return reply.send(
          await deps.agentMemberToolingService.probeTool(principal.workspace, principal.subject, req.params.key),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Bind a tool's declared secrets to real secret names. Unlike the on/off overlay this edits the WORKSPACE agent
  // configuration (that is where an adoption's binding lives), so it is gated agents:write, not self-scoped.
  app.put<{ Params: { key: string } }>(
    "/agent/tools/:key/secrets",
    { schema: agentToolDocs.bindToolSecrets },
    async (req, reply) => {
      if (!deps.agentMemberToolingService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "agent tooling service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "agents:write");
      } catch (err) {
        return sendError(reply, err);
      }
      const parsed = BindAgentToolSecretsBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
      try {
        return reply.send(
          await deps.agentMemberToolingService.bindToolSecrets(
            principal.workspace,
            principal.subject,
            req.params.key,
            parsed.data.bindings,
          ),
        );
      } catch (err) {
        return sendError(reply, err); // undeclared name → 400 · unknown key → 404
      }
    },
  );

  app.get("/agent/skills", { schema: agentToolDocs.listSkills }, async (req, reply) => {
    if (!deps.agentMemberToolingService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "agent tooling service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      return reply.send(await deps.agentMemberToolingService.listSkills(principal.workspace, principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/agent/skills", { schema: agentToolDocs.setSkill }, async (req, reply) => {
    if (!deps.agentMemberToolingService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "agent tooling service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = SetAgentToolBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(
        await deps.agentMemberToolingService.setSkill(
          principal.workspace,
          principal.subject,
          parsed.data.key,
          parsed.data.enabled,
        ),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
