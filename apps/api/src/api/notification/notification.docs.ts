import { NotificationFeedResponseSchema } from "@everdict/contracts/wire";
import { ReadNotificationsResultResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { ReadNotificationsBodySchema } from "./request/read-notifications.js";

// OpenAPI descriptors for the notification routes (doc-only — never validates/serializes; see api/openapi.ts).
// Personal feed (bell inbox) — self-scoped to the caller + active workspace, no role gate.
// docs/architecture/notifications.md.
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
export const notificationDocs: Record<"list" | "markRead" | "approvalClear", FastifySchema> = {
  approvalClear: {
    summary: "Clear a conversation's approval-request notification (internal)",
    description:
      "Agent service → CP bridge (docs/architecture/notifications.md N8): a conversation's parked approval was " +
      "decided (allow/deny/expiry), so the `agent_approval_requested` bell row — keyed deterministically by the " +
      'session — is deleted. A decided ask must not keep saying "approval needed". Idempotent. Guarded by ' +
      "x-internal-token (403 on mismatch; fail-closed 404 when unset).",
    tags: ["internal"],
    body: toJsonSchema(z.object({ tenant: z.string().min(1), sessionId: z.string().min(1) })),
    response: {
      200: { description: "Cleared (or nothing to clear)", ...toJsonSchema(z.object({ ok: z.boolean() })) },
      ...errorResponses(400, 403, 404),
    },
  },
  list: {
    summary: "My notification feed",
    description:
      "The caller's personal notifications in the active workspace (job completions, mentions, …), newest first. " +
      "Self-scoped — you only ever see your own feed; no role gate.",
    tags: ["notification"],
    querystring: toJsonSchema(
      z.object({
        unread: z.string().optional().describe('"1" or "true" = unread only'),
        limit: z.string().optional().describe("Max items (positive integer, capped at 200; default 50)"),
      }),
    ),
    response: {
      200: { description: "Personal feed (newest first)", ...toJsonSchema(NotificationFeedResponseSchema) },
      ...errorResponses(401, 404),
    },
  },
  markRead: {
    summary: "Mark notifications read",
    description:
      "Marks the given ids (or all:true for everything) as read in the caller's own feed. Idempotent — already-read items are " +
      "left alone; returns the count newly processed. An empty body is a no-op (read: 0).",
    tags: ["notification"],
    body: toJsonSchema(ReadNotificationsBodySchema),
    response: {
      200: { description: "Processed count", ...toJsonSchema(ReadNotificationsResultResponseSchema) },
      ...errorResponses(400, 401, 404),
    },
  },
};
