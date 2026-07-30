import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, constantTimeEq, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { CreateSandboxBodySchema } from "./request/create-sandbox.js";
import { ExecSandboxBodySchema } from "./request/exec-sandbox.js";
import { ReadSandboxTaskTraceQuerySchema } from "./request/read-sandbox-task-trace.js";
import { SubmitSandboxTaskBodySchema } from "./request/submit-sandbox-task.js";
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

  // The reattach surface: live sessions on THIS control plane (bounded by the global cap — no pagination).
  app.get("/sandboxes", { schema: sandboxDocs.list }, async (req, reply) => {
    if (!deps.sandboxSessions)
      return reply.code(404).send({ code: "NOT_FOUND", message: "sandbox sessions not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      return reply.send({
        sessions: await deps.sandboxSessions.listSessions({
          tenant: principal.workspace,
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        }),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/sandboxes/:id", { schema: sandboxDocs.get }, async (req, reply) => {
    if (!deps.sandboxSessions)
      return reply.code(404).send({ code: "NOT_FOUND", message: "sandbox sessions not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      return reply.send(
        await deps.sandboxSessions.getSession(
          { tenant: principal.workspace, subject: principal.subject, isAdmin: principal.roles.includes("admin") },
          req.params.id,
        ),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The playground: submit one ad-hoc test case into a live harness session. 202 — the child run is the
  // monitoring handle; its trace is read via the task-trace poll below (and, after settle, /runs/:id/trajectory).
  app.post<{ Params: { id: string } }>("/sandboxes/:id/tasks", { schema: sandboxDocs.submitTask }, async (req, reply) => {
    if (!deps.sandboxSessions)
      return reply.code(404).send({ code: "NOT_FOUND", message: "sandbox sessions not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:submit");
      const parsed = SubmitSandboxTaskBodySchema.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
      return reply.code(202).send(
        await deps.sandboxSessions.submitTask(
          { tenant: principal.workspace, subject: principal.subject, isAdmin: principal.roles.includes("admin") },
          req.params.id,
          parsed.data,
        ),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string; taskId: string }; Querystring: { since?: string } }>(
    "/sandboxes/:id/tasks/:taskId/trace",
    { schema: sandboxDocs.taskTrace },
    async (req, reply) => {
      if (!deps.sandboxSessions)
        return reply.code(404).send({ code: "NOT_FOUND", message: "sandbox sessions not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
        const parsed = ReadSandboxTaskTraceQuerySchema.safeParse(req.query);
        if (!parsed.success)
          return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
        return reply.send(
          await deps.sandboxSessions.readTaskTrace(
            { tenant: principal.workspace, subject: principal.subject, isAdmin: principal.roles.includes("admin") },
            req.params.id,
            req.params.taskId,
            parsed.data.since,
          ),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

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

  // The durable reaper's teardown (T-b): the reaper:<runId> workflow's deadline timer → this route. A live
  // handle tears down as expired; a running row whose handle died with an earlier process settles as
  // orphaned and its stray container is removed by the recorded compute id. Idempotent — a settled row skips.
  app.post<{ Params: { id: string } }>(
    "/internal/sandboxes/:id/reap",
    { schema: sandboxDocs.reap },
    async (req, reply) => {
      if (!deps.internalToken || !deps.sandboxSessions)
        return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
      const provided = req.headers["x-internal-token"];
      if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
        return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
      const body = z.object({ tenant: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
      try {
        return reply.send(await deps.sandboxSessions.reap(body.data.tenant, req.params.id));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

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
