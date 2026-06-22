import { randomBytes, randomUUID } from "node:crypto";
import type { SqlClient } from "./client.js";
import { hashKey } from "./tenant-auth.js";
import type { WorkspaceStore } from "./workspace-store.js";

// 워크스페이스 초대(토큰/링크 redemption) 저장소 — 평문 토큰은 절대 저장하지 않고 SHA-256 해시만 보관(tenant-keys 와 동일).
// 초대 = 가입 비밀: 해시 전용 · 만료 · 단일 사용. consume 는 단일 CTE 로 원자적(SqlClient 에 트랜잭션이 없으므로).
export { hashKey }; // 서비스가 평문 토큰을 해시해 넘길 때 재사용

export interface WorkspaceInviteMeta {
  id: string;
  workspace: string;
  role: string;
  createdBy: string;
  prefix: string; // inv_abcd… 식별 힌트(해시/평문 아님)
  createdAt: string;
  expiresAt?: string;
  accepted: boolean;
  acceptedBy?: string;
  acceptedAt?: string;
}

export interface ConsumeResult {
  workspace: string;
  role: string;
}

// 수락 결과 — 실패 사유를 구분(서비스가 AppError 로 매핑). 클라이언트엔 사유를 그대로 노출하지 않는다(존재 누출 방지는 서비스 책임).
export type ConsumeOutcome =
  | { ok: true; result: ConsumeResult }
  | { ok: false; reason: "unknown" | "expired" | "accepted" };

export interface CreateInviteInput {
  workspace: string;
  role: string;
  createdBy: string;
  tokenHash: string;
  prefix: string;
  expiresAt?: string;
}

export interface WorkspaceInviteStore {
  createInvite(input: CreateInviteInput): Promise<WorkspaceInviteMeta>;
  listInvites(workspace: string): Promise<WorkspaceInviteMeta[]>; // 메타만 — token_hash 절대 미반환
  revokeInvite(workspace: string, id: string): Promise<void>; // tenant 스코프, 멱등(no-op)
  // 원자적: 존재+미만료+미수락 확인 → 멤버십 생성/email 갱신 → invite accepted 마킹.
  consumeInvite(tokenHash: string, subject: string, email?: string): Promise<ConsumeOutcome>;
}

// inv_<랜덤> — 평문 초대 토큰(링크에 담김). 생성 시 한 번만 노출되고 저장은 해시만.
export function generateInviteToken(): string {
  return `inv_${randomBytes(24).toString("base64url")}`;
}

interface InviteRow {
  id: string;
  workspace: string;
  role: string;
  createdBy: string;
  prefix: string;
  createdAt: string;
  expiresAt?: string;
  acceptedAt?: string;
  acceptedBy?: string;
}

function meta(r: InviteRow): WorkspaceInviteMeta {
  return {
    id: r.id,
    workspace: r.workspace,
    role: r.role,
    createdBy: r.createdBy,
    prefix: r.prefix,
    createdAt: r.createdAt,
    accepted: r.acceptedAt !== undefined,
    ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
    ...(r.acceptedAt !== undefined ? { acceptedAt: r.acceptedAt } : {}),
    ...(r.acceptedBy !== undefined ? { acceptedBy: r.acceptedBy } : {}),
  };
}

export class InMemoryWorkspaceInviteStore implements WorkspaceInviteStore {
  private readonly byHash = new Map<string, InviteRow>(); // tokenHash → row
  constructor(
    private readonly members: WorkspaceStore, // consume 시 멤버십 생성/갱신에 사용
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async createInvite(input: CreateInviteInput): Promise<WorkspaceInviteMeta> {
    const row: InviteRow = {
      id: randomUUID(),
      workspace: input.workspace,
      role: input.role,
      createdBy: input.createdBy,
      prefix: input.prefix,
      createdAt: this.now(),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
    this.byHash.set(input.tokenHash, row);
    return meta(row);
  }

  async listInvites(workspace: string): Promise<WorkspaceInviteMeta[]> {
    return [...this.byHash.values()]
      .filter((r) => r.workspace === workspace)
      .map(meta)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // 최신순
  }

  async revokeInvite(workspace: string, id: string): Promise<void> {
    for (const [hash, r] of this.byHash) if (r.workspace === workspace && r.id === id) this.byHash.delete(hash);
  }

  async consumeInvite(tokenHash: string, subject: string, email?: string): Promise<ConsumeOutcome> {
    const row = this.byHash.get(tokenHash);
    if (!row) return { ok: false, reason: "unknown" };
    if (row.acceptedAt !== undefined) return { ok: false, reason: "accepted" };
    if (row.expiresAt !== undefined && row.expiresAt <= this.now()) return { ok: false, reason: "expired" };
    row.acceptedAt = this.now();
    row.acceptedBy = subject;
    await this.members.ensureMembership(row.workspace, subject, row.role, email);
    // 기존 멤버였다면 role 은 유지되므로 실제 역할을 읽어 보고(공유 링크로 권한 변경 방지).
    const finalRole = (await this.members.roleFor(row.workspace, subject)) ?? row.role;
    return { ok: true, result: { workspace: row.workspace, role: finalRole } };
  }
}

interface InviteMetaRow {
  id: string;
  workspace: string;
  role: string;
  created_by: string;
  prefix: string;
  created_at: string | Date;
  expires_at: string | Date | null;
  accepted_at: string | Date | null;
  accepted_by: string | null;
}

function rowToMeta(r: InviteMetaRow): WorkspaceInviteMeta {
  return {
    id: r.id,
    workspace: r.workspace,
    role: r.role,
    createdBy: r.created_by,
    prefix: r.prefix,
    createdAt: new Date(r.created_at).toISOString(),
    accepted: r.accepted_at !== null,
    ...(r.expires_at !== null ? { expiresAt: new Date(r.expires_at).toISOString() } : {}),
    ...(r.accepted_at !== null ? { acceptedAt: new Date(r.accepted_at).toISOString() } : {}),
    ...(r.accepted_by !== null ? { acceptedBy: r.accepted_by } : {}),
  };
}

export class PgWorkspaceInviteStore implements WorkspaceInviteStore {
  constructor(private readonly client: SqlClient) {}

  async createInvite(input: CreateInviteInput): Promise<WorkspaceInviteMeta> {
    const id = randomUUID();
    const res = await this.client.query<{ created_at: string | Date }>(
      `INSERT INTO assay_workspace_invites (token_hash, id, workspace, role, created_by, prefix, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING created_at`,
      [input.tokenHash, id, input.workspace, input.role, input.createdBy, input.prefix, input.expiresAt ?? null],
    );
    const r = res.rows[0];
    if (!r) throw new Error("invite insert 가 행을 돌려주지 않았습니다.");
    return {
      id,
      workspace: input.workspace,
      role: input.role,
      createdBy: input.createdBy,
      prefix: input.prefix,
      createdAt: new Date(r.created_at).toISOString(),
      accepted: false,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
  }

  async listInvites(workspace: string): Promise<WorkspaceInviteMeta[]> {
    // token_hash 는 select 하지 않는다(절대 노출 금지).
    const res = await this.client.query<InviteMetaRow>(
      `SELECT id, workspace, role, created_by, prefix, created_at, expires_at, accepted_at, accepted_by
       FROM assay_workspace_invites WHERE workspace = $1 ORDER BY created_at DESC`,
      [workspace],
    );
    return res.rows.map(rowToMeta);
  }

  async revokeInvite(workspace: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM assay_workspace_invites WHERE workspace = $1 AND id = $2", [workspace, id]);
  }

  async consumeInvite(tokenHash: string, subject: string, email?: string): Promise<ConsumeOutcome> {
    // 단일 CTE = 원자적. accepted_at IS NULL 가 단일사용 락(동시 redeem 은 2번째가 0행).
    // 기존 멤버는 role 유지(email 만 COALESCE 갱신) — 공유 링크로 권한이 바뀌지 않게.
    const res = await this.client.query<{ workspace: string; role: string }>(
      `WITH claimed AS (
         UPDATE assay_workspace_invites SET accepted_at = now(), accepted_by = $2
          WHERE token_hash = $1 AND accepted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
         RETURNING workspace, role
       ),
       member AS (
         INSERT INTO assay_workspace_members (workspace, subject, role, email)
         SELECT workspace, $2, role, $3 FROM claimed
         ON CONFLICT (workspace, subject)
         DO UPDATE SET email = COALESCE(EXCLUDED.email, assay_workspace_members.email)
         RETURNING workspace, role
       )
       SELECT workspace, role FROM member`,
      [tokenHash, subject, email ?? null],
    );
    const row = res.rows[0];
    if (row) return { ok: true, result: { workspace: row.workspace, role: row.role } };
    // 실패 — 읽기전용 후속 분류(성공 경로 원자성 무관).
    const why = await this.client.query<{ accepted_at: string | Date | null; expires_at: string | Date | null }>(
      "SELECT accepted_at, expires_at FROM assay_workspace_invites WHERE token_hash = $1",
      [tokenHash],
    );
    const w = why.rows[0];
    if (!w) return { ok: false, reason: "unknown" }; // 없음 == 취소됨(구분 안 함)
    if (w.accepted_at !== null) return { ok: false, reason: "accepted" };
    return { ok: false, reason: "expired" };
  }
}
