import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, constantTimeEq, gate, resolvePrincipal, sendError } from "../route-context.js";
import { approvalDocs } from "./approval.docs.js";

const listQuery = z.object({
  status: z.enum(["pending", "approved", "denied", "expired"]).optional(),
  sessionId: z.string().min(1).optional(),
});

const decideBody = z.object({ decision: z.enum(["approve", "deny"]) });

const registerBody = z.object({
  tenant: z.string().min(1),
  sessionId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  requestId: z.string().min(1),
  request: z.object({ name: z.string().min(1), input: z.unknown().optional() }),
  ttlSec: z
    .number()
    .int()
    .min(60)
    .max(30 * 24 * 3600)
    .optional(),
});

const settleBody = z.object({ tenant: z.string().min(1), decision: z.enum(["approve", "deny"]) });

// Durable agent approvals (agent-automation A6): members list/decide; the agent service parks and settles
// over the internal bridge (same x-internal-token discipline as the batch/score bridges). Authz: list =
// agents:read (viewer+ — the parked ask is workspace-visible governance), decide = agents:write (member+ —
// deciding shapes what the workspace's agent does, the same weight as editing its config).
export function registerApprovalRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/approvals", { schema: approvalDocs.list }, async (req, reply) => {
    if (!deps.approvalService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "approval service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "agents:read");
      const query = listQuery.parse(req.query ?? {});
      return reply.send(
        await deps.approvalService.list(principal.workspace, {
          ...(query.status ? { status: query.status } : {}),
          ...(query.sessionId ? { sessionId: query.sessionId } : {}),
        }),
      );
    } catch (err) {
      if (err instanceof z.ZodError) return reply.code(400).send({ code: "BAD_REQUEST", message: err.message });
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/approvals/:id/decide", { schema: approvalDocs.decide }, async (req, reply) => {
    if (!deps.approvalService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "approval service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "agents:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const body = decideBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      return reply.send(
        await deps.approvalService.decide({
          tenant: principal.workspace,
          id: req.params.id,
          decision: body.data.decision,
          decidedBy: principal.subject,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- internal bridges (agent service → CP; x-internal-token, fail-closed like the other bridges) ---
  app.post("/internal/approvals", { schema: approvalDocs.register }, async (req, reply) => {
    if (!deps.internalToken || !deps.approvalService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
    const body = registerBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      return reply.code(201).send(await deps.approvalService.create(body.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Deny-on-expiry (the approval workflow's timer → this route). Idempotent — a settled record skips.
  app.post<{ Params: { id: string } }>(
    "/internal/approvals/:id/expire",
    { schema: approvalDocs.expire },
    async (req, reply) => {
      if (!deps.internalToken || !deps.approvalService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
      const provided = req.headers["x-internal-token"];
      if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
        return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
      const body = z.object({ tenant: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
      try {
        const record = await deps.approvalService.expire({ tenant: body.data.tenant, id: req.params.id });
        if (!record) return reply.code(404).send({ code: "NOT_FOUND", message: "approval not found." });
        return reply.send(record);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/internal/approvals/:id/settle",
    { schema: approvalDocs.settle },
    async (req, reply) => {
      if (!deps.internalToken || !deps.approvalService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
      const provided = req.headers["x-internal-token"];
      if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
        return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
      const body = settleBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
      try {
        const record = await deps.approvalService.settleFromAgent({
          tenant: body.data.tenant,
          id: req.params.id,
          decision: body.data.decision,
        });
        if (!record) return reply.code(404).send({ code: "NOT_FOUND", message: "approval not found." });
        return reply.send(record);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
