import type { FastifyInstance } from "fastify";
import { type ServerDeps, resolvePrincipal, sendError } from "../route-context.js";
import { agentToolDocs } from "./agent-tool.docs.js";
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
