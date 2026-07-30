import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { CreateSandboxBodySchema } from "./request/create-sandbox.js";
import { ExecSandboxBodySchema } from "./request/exec-sandbox.js";
import { sandboxDocs } from "./sandbox.docs.js";

// Sandbox session runs (execution-model P6) — "run this environment image and shell in", on the universal
// Run ledger. Composed only where a container runtime is reachable (EVERDICT_SANDBOX_DRIVER=docker);
// everywhere else the routes are simply absent. Creator-or-admin on exec/close lives in the SERVICE (it
// must hold before anything runs), the routes only authenticate + role-gate.
export function registerSandboxRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/sandboxes", { schema: sandboxDocs.create }, async (req, reply) => {
    if (!deps.sandboxSessions)
      return reply.code(404).send({ code: "NOT_FOUND", message: "sandbox sessions not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:submit");
      const parsed = CreateSandboxBodySchema.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
      return reply.send(
        await deps.sandboxSessions.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          ...parsed.data,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/sandboxes/:id/exec", { schema: sandboxDocs.exec }, async (req, reply) => {
    if (!deps.sandboxSessions)
      return reply.code(404).send({ code: "NOT_FOUND", message: "sandbox sessions not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const parsed = ExecSandboxBodySchema.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
      return reply.send(
        await deps.sandboxSessions.exec(
          { tenant: principal.workspace, subject: principal.subject, isAdmin: principal.roles.includes("admin") },
          req.params.id,
          parsed.data,
        ),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/sandboxes/:id/close", { schema: sandboxDocs.close }, async (req, reply) => {
    if (!deps.sandboxSessions)
      return reply.code(404).send({ code: "NOT_FOUND", message: "sandbox sessions not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      return reply.send(
        await deps.sandboxSessions.close(
          { tenant: principal.workspace, subject: principal.subject, isAdmin: principal.roles.includes("admin") },
          req.params.id,
        ),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
