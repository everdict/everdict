import { z } from "zod";
import type { SqlClient } from "../client.js";

// Notification feed — the web bell inbox/desktop native notifications consume "the job I asked for is done".
// Personally owned (recipient=subject) + workspace-scoped — same self-scoped model as connections/runners.
// Design: docs/architecture/notifications.md (N1~N5).
export const NotificationKindSchema = z.enum([
  "run_completed",
  "run_failed",
  "scorecard_completed",
  "scorecard_failed",
  "schedule_regression",
  "comment_mention", // @-mentioned in a comment — the link jumps straight to that context (dataset comment)
]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const NotificationRecordSchema = z.object({
  id: z.string(),
  workspace: z.string(),
  recipient: z.string(), // the person who asked for the job (subject) — N2
  kind: NotificationKindSchema,
  title: z.string(),
  body: z.string().optional(),
  // Where a click navigates — run/scorecard detail, or a resource comment (mention: to that detail via resourceType+resourceId +
  // scroll to the commentId anchor). resourceType ∈ dataset|harness|scorecard|view|schedule|run|runtime.
  link: z
    .object({
      runId: z.string().optional(),
      scorecardId: z.string().optional(),
      resourceType: z.string().optional(),
      resourceId: z.string().optional(),
      commentId: z.string().optional(),
    })
    .optional(),
  createdAt: z.string(),
  readAt: z.string().optional(),
});
export type NotificationRecord = z.infer<typeof NotificationRecordSchema>;

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

const DEFAULT_LIMIT = 50;

export class InMemoryNotificationStore implements NotificationStore {
  private readonly rows: NotificationRecord[] = [];

  async add(record: NotificationRecord): Promise<void> {
    this.rows.push(record);
  }

  async list(recipient: string, workspace: string, opts?: NotificationListOptions): Promise<NotificationRecord[]> {
    return this.rows
      .filter(
        (r) =>
          r.recipient === recipient &&
          r.workspace === workspace &&
          (opts?.unreadOnly !== true || r.readAt === undefined),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, opts?.limit ?? DEFAULT_LIMIT);
  }

  async markRead(recipient: string, workspace: string, ids: string[] | "all", readAt: string): Promise<number> {
    let count = 0;
    for (const [i, r] of this.rows.entries()) {
      if (r.recipient !== recipient || r.workspace !== workspace || r.readAt !== undefined) continue;
      if (ids !== "all" && !ids.includes(r.id)) continue;
      this.rows[i] = { ...r, readAt };
      count++;
    }
    return count;
  }
}

interface NotificationRow {
  id: string;
  workspace: string;
  recipient: string;
  kind: string;
  title: string;
  body: string | null;
  link: unknown;
  created_at: string | Date;
  read_at: string | Date | null;
}

function rowToRecord(row: NotificationRow): NotificationRecord {
  return NotificationRecordSchema.parse({
    id: row.id,
    workspace: row.workspace,
    recipient: row.recipient,
    kind: row.kind,
    title: row.title,
    ...(row.body !== null ? { body: row.body } : {}),
    ...(row.link !== null && row.link !== undefined ? { link: row.link } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.read_at !== null ? { readAt: new Date(row.read_at).toISOString() } : {}),
  });
}

export class PgNotificationStore implements NotificationStore {
  constructor(private readonly client: SqlClient) {}

  async add(record: NotificationRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_notifications (id, workspace, recipient, kind, title, body, link, created_at, read_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        record.id,
        record.workspace,
        record.recipient,
        record.kind,
        record.title,
        record.body ?? null,
        record.link !== undefined ? JSON.stringify(record.link) : null,
        record.createdAt,
        record.readAt ?? null,
      ],
    );
  }

  async list(recipient: string, workspace: string, opts?: NotificationListOptions): Promise<NotificationRecord[]> {
    const unread = opts?.unreadOnly === true ? " AND read_at IS NULL" : "";
    const res = await this.client.query<NotificationRow>(
      `SELECT id, workspace, recipient, kind, title, body, link, created_at, read_at
       FROM everdict_notifications WHERE recipient = $1 AND workspace = $2${unread}
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [recipient, workspace, opts?.limit ?? DEFAULT_LIMIT],
    );
    return res.rows.map(rowToRecord);
  }

  async markRead(recipient: string, workspace: string, ids: string[] | "all", readAt: string): Promise<number> {
    if (ids !== "all" && ids.length === 0) return 0;
    const idFilter = ids === "all" ? "" : " AND id = ANY($4)";
    const params: unknown[] = [recipient, workspace, readAt];
    if (ids !== "all") params.push(ids);
    // SqlClient exposes only rows — count the processed rows via RETURNING.
    const res = await this.client.query<{ id: string }>(
      `UPDATE everdict_notifications SET read_at = $3
       WHERE recipient = $1 AND workspace = $2 AND read_at IS NULL${idFilter}
       RETURNING id`,
      params,
    );
    return res.rows.length;
  }
}
