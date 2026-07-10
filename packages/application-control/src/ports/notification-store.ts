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
}
