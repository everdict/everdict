import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, constantTimeEq, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { notificationDocs } from "./notification.docs.js";
import { ReadNotificationsBodySchema } from "./request/read-notifications.js";

const approvalClearBody = z.object({ tenant: z.string().min(1), sessionId: z.string().min(1) });

// notifications (personal feed — bell inbox; self-scoped, no role gate).
export function registerNotificationRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- notifications (personal notification feed — bell inbox; self-scoped like connections/runners, no role gate.
  //     docs/architecture/notifications.md — the web consumes it by polling, new items fire as browser/desktop native notifications) ---
  app.get("/notifications", { schema: notificationDocs.list }, async (req, reply) => {
    if (!deps.notificationService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "notification service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const q = req.query as { unread?: string; limit?: string };
    const limit = q.limit !== undefined ? Number(q.limit) : Number.NaN;
    try {
      // Personal-owned — only the feed for the subject + active workspace.
      const notifications = await deps.notificationService.listFeed(principal.subject, principal.workspace, {
        ...(q.unread === "1" || q.unread === "true" ? { unreadOnly: true } : {}),
        ...(Number.isInteger(limit) && limit > 0 ? { limit: Math.min(limit, 200) } : {}),
      });
      return reply.send({ notifications });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Mark read — {ids:[…]} or {all:true}. Returns the count processed (idempotent — already-read items are left alone).
  app.post("/notifications/read", { schema: notificationDocs.markRead }, async (req, reply) => {
    if (!deps.notificationService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "notification service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = ReadNotificationsBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      const read = await deps.notificationService.markFeedRead(
        principal.subject,
        principal.workspace,
        body.data.all === true ? "all" : (body.data.ids ?? []),
      );
      return reply.send({ read });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- internal bridge (agent service → CP; x-internal-token, fail-closed like the other bridges) ---
  // A conversation's parked approval was decided (allow/deny/expiry) — delete its bell row (N8): the ask
  // stops being true the moment it is decided, and the freed deterministic id lets the session's next ask
  // ping again. Discussion asks clear through the comment-activity lifecycle instead (CommentService).
  app.post("/internal/notifications/approval-clear", { schema: notificationDocs.approvalClear }, async (req, reply) => {
    if (!deps.internalToken || !deps.notificationService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
    const body = approvalClearBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      await deps.notificationService.clearApprovalRequest(body.data.tenant, {
        kind: "conversation",
        sessionId: body.data.sessionId,
      });
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
