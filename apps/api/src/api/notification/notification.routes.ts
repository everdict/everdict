import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { ReadNotificationsBodySchema } from "./notification.schema.js";

// notifications (personal feed — bell inbox; self-scoped, no role gate).
export function registerNotificationRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- notifications (personal notification feed — bell inbox; self-scoped like connections/runners, no role gate.
  //     docs/architecture/notifications.md — the web consumes it by polling, new items fire as browser/desktop native notifications) ---
  app.get("/notifications", async (req, reply) => {
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
  app.post("/notifications/read", async (req, reply) => {
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

  // Workspace runner roster — runners paired in this workspace (metadata only, no tokens). Read-only (members:read).
}
