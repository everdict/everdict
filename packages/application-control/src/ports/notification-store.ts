import type { NotificationRecord } from "@everdict/contracts";

export interface NotificationListOptions {
  unreadOnly?: boolean;
  limit?: number; // default 50 — the bell inbox shows only recent ones
}

export interface NotificationStore {
  add(record: NotificationRecord): Promise<void>;
  // Newest first (createdAt DESC). Own (recipient) + workspace scoped.
  list(recipient: string, workspace: string, opts?: NotificationListOptions): Promise<NotificationRecord[]>;
  // Mark ids or all as read — returns the number processed (doesn't touch already-read ones).
  markRead(recipient: string, workspace: string, ids: string[] | "all", readAt: string): Promise<number>;
  // Delete a row outright — for notifications that stop being TRUE once acted on (a decided approval ask, N8):
  // read-history would misreport "approval needed" forever, and the deterministic id must be free for the
  // session's NEXT ask to ping again. Idempotent — a missing id is a no-op.
  remove(workspace: string, id: string): Promise<void>;
}
