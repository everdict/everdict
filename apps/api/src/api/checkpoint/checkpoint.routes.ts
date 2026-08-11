import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { checkpointDocs } from "./checkpoint.docs.js";
import { CreateCheckpointBodySchema } from "./request/create-checkpoint.js";

// Handoff checkpoints (ownership protocol O6 — docs/architecture/ownership-protocol.md): the resumable state
// transfer an autonomous task leaves when it stops at its envelope's boundary. Append-only — no PATCH, no
// DELETE, because a predecessor must not be able to rewrite evidence its successor already acted on.
// Authz reuses the agent actions (no new action): read = agents:read, write = agents:write — a checkpoint is
// what the workspace's autonomous work leaves behind, so whoever may see agents may see their handoffs.
export function registerCheckpointRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/checkpoints", { schema: checkpointDocs.create }, async (req, reply) => {
    if (!deps.checkpointService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "checkpoint service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "agents:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof CreateCheckpointBodySchema>;
    try {
      body = CreateCheckpointBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      // Dangling evidence and self-verification are refused in the service (400) — both need other records.
      const { envelope, ...checkpoint } = body;
      return reply.code(201).send(
        await deps.checkpointService.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          checkpoint,
          ...(envelope ? { envelope } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { envelopeId?: string; limit?: string } }>(
    "/checkpoints",
    { schema: checkpointDocs.list },
    async (req, reply) => {
      if (!deps.checkpointService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "checkpoint service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "agents:read");
      } catch (err) {
        return sendError(reply, err);
      }
      const limit = Number.parseInt(req.query.limit ?? "", 10);
      return reply.send(
        await deps.checkpointService.list(principal.workspace, {
          ...(req.query.envelopeId !== undefined ? { envelopeId: req.query.envelopeId } : {}),
          ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
        }),
      );
    },
  );

  // A LEAD ASKS FOR A VERIFICATION — the request surface the ownership protocol deliberately does not make
  // automatic. `checkpoint.created` is not trigger-matchable (an agent waking on another agent's handoff is
  // the runaway vector the `agent.run.*` family is excluded for), so verification is a JUDGMENT someone makes
  // about work they delegated, not an ambient reaction to a handoff being filed.
  //
  // `agents:write` rather than a new action: requesting one spends the workspace's compute and files a
  // durable judgment, which is the same authority every other agent-launching surface already gates on.
  app.post<{ Params: { id: string }; Body: { focus?: string } }>(
    "/checkpoints/:id/verify",
    { schema: checkpointDocs.verify },
    async (req, reply) => {
      if (!deps.checkpointService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "checkpoint service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "agents:write");
      } catch (err) {
        return sendError(reply, err);
      }
      try {
        return reply.send(
          await deps.checkpointService.requestVerification(principal.workspace, req.params.id, {
            ...(req.body?.focus !== undefined ? { focus: req.body.focus } : {}),
            requestedBy: principal.subject,
          }),
        );
      } catch (err) {
        // No verifier runtime → 400 saying verification is a human act here; a verifier that is not
        // independent → the domain's refusal. Neither ever becomes a pass.
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/checkpoints/:id", { schema: checkpointDocs.get }, async (req, reply) => {
    if (!deps.checkpointService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "checkpoint service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "agents:read");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      return reply.send(await deps.checkpointService.get(principal.workspace, req.params.id)); // another workspace's → 404
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
