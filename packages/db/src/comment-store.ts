import { z } from "zod";
import type { SqlClient } from "./client.js";

// 리소스(데이터셋 등)에 달리는 댓글 — Linear 이슈 댓글처럼 협업 논의를 남긴다. 활동 타임라인에 이벤트와 섞여 흐른다.
// resourceType 은 확장 가능(현재 "dataset"). 워크스페이스 스코프 + author=작성자 subject.
export const CommentRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  resourceType: z.string(), // "dataset"|"harness"|"scorecard"|"view"|"schedule"|"run"|"runtime"
  resourceId: z.string(),
  parentId: z.string().optional(), // 대댓글이면 부모 댓글 id(같은 리소스, 최상위만 부모 — 1단계 스레드). 없으면 최상위.
  author: z.string(), // 작성자 subject
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CommentRecord = z.infer<typeof CommentRecordSchema>;

export interface CommentStore {
  add(record: CommentRecord): Promise<void>;
  // 오래된→최신(createdAt ASC) — 타임라인 순서. 워크스페이스+리소스 스코프.
  list(tenant: string, resourceType: string, resourceId: string): Promise<CommentRecord[]>;
  get(tenant: string, id: string): Promise<CommentRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}

export class InMemoryCommentStore implements CommentStore {
  private readonly rows: CommentRecord[] = [];

  async add(record: CommentRecord): Promise<void> {
    this.rows.push(record);
  }

  async list(tenant: string, resourceType: string, resourceId: string): Promise<CommentRecord[]> {
    return this.rows
      .filter((r) => r.tenant === tenant && r.resourceType === resourceType && r.resourceId === resourceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(tenant: string, id: string): Promise<CommentRecord | undefined> {
    return this.rows.find((r) => r.tenant === tenant && r.id === id);
  }

  async remove(tenant: string, id: string): Promise<void> {
    // 자기 자신 + 이 댓글에 달린 대댓글(children)까지 함께 삭제(고아 대댓글 방지).
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i];
      if (r && r.tenant === tenant && (r.id === id || r.parentId === id)) this.rows.splice(i, 1);
    }
  }
}

interface CommentRow {
  id: string;
  tenant: string;
  resource_type: string;
  resource_id: string;
  parent_id: string | null;
  author: string;
  body: string;
  created_at: string | Date;
  updated_at: string | Date;
}

function rowToRecord(row: CommentRow): CommentRecord {
  return CommentRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    ...(row.parent_id !== null ? { parentId: row.parent_id } : {}),
    author: row.author,
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

export class PgCommentStore implements CommentStore {
  constructor(private readonly client: SqlClient) {}

  async add(record: CommentRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO assay_comments (id, tenant, resource_type, resource_id, parent_id, author, body, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        record.id,
        record.tenant,
        record.resourceType,
        record.resourceId,
        record.parentId ?? null,
        record.author,
        record.body,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async list(tenant: string, resourceType: string, resourceId: string): Promise<CommentRecord[]> {
    const res = await this.client.query<CommentRow>(
      `SELECT id, tenant, resource_type, resource_id, parent_id, author, body, created_at, updated_at
       FROM assay_comments WHERE tenant = $1 AND resource_type = $2 AND resource_id = $3
       ORDER BY created_at ASC, id ASC`,
      [tenant, resourceType, resourceId],
    );
    return res.rows.map(rowToRecord);
  }

  async get(tenant: string, id: string): Promise<CommentRecord | undefined> {
    const res = await this.client.query<CommentRow>(
      `SELECT id, tenant, resource_type, resource_id, parent_id, author, body, created_at, updated_at
       FROM assay_comments WHERE tenant = $1 AND id = $2`,
      [tenant, id],
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
  }

  async remove(tenant: string, id: string): Promise<void> {
    // 자기 자신 + 대댓글(parent_id = id)까지 함께 삭제(고아 방지).
    await this.client.query("DELETE FROM assay_comments WHERE tenant = $1 AND (id = $2 OR parent_id = $2)", [
      tenant,
      id,
    ]);
  }
}
