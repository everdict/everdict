import type { SqlClient } from "./client.js";

// 워크스페이스 멤버십 저장소 — subject(유저 sub/키)가 어떤 workspace 에 어떤 role 로 속하는지.
// workspace === tenant === trust-zone 키. 컨트롤플레인이 멤버십의 SSOT(토큰 클레임은 부트스트랩 기본값일 뿐).
// 평문/비밀 없음 — 순수 멤버십 그래프. role → action 매핑은 @assay/auth 의 authz 가 담당한다.
export interface WorkspaceRecord {
  id: string; // = tenant 키(모든 데이터 스코프)
  name: string; // 표시 이름
  owner: string; // 생성한 subject
  createdAt: string;
}

// 특정 subject 관점의 워크스페이스(그 subject 의 멤버십 역할 포함).
export interface WorkspaceWithRole {
  id: string;
  name: string;
  role: string;
}

export interface WorkspaceStore {
  // 워크스페이스 생성 + 생성자를 admin 멤버로. id 충돌 시 undefined(서비스가 ConflictError 로 매핑).
  create(rec: { id: string; name: string; owner: string }): Promise<WorkspaceRecord | undefined>;
  get(id: string): Promise<WorkspaceRecord | undefined>;
  // subject 가 멤버인 워크스페이스 목록(역할 포함), 생성 시각 오름차순.
  listForSubject(subject: string): Promise<WorkspaceWithRole[]>;
  // (workspace, subject) 멤버십 역할 — 멤버가 아니면 undefined.
  roleFor(workspace: string, subject: string): Promise<string | undefined>;
  // 멱등 부트스트랩: 워크스페이스 + 멤버십을 없을 때만 만든다(기존 토큰/dev workspace 를 멤버십으로 승격).
  ensureMembership(workspace: string, subject: string, role: string): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly members = new Map<string, Map<string, string>>(); // workspace → (subject → role)

  async create(rec: { id: string; name: string; owner: string }): Promise<WorkspaceRecord | undefined> {
    if (this.workspaces.has(rec.id)) return undefined;
    const full: WorkspaceRecord = { ...rec, createdAt: nowIso() };
    this.workspaces.set(rec.id, full);
    this.setMember(rec.id, rec.owner, "admin", false);
    return full;
  }

  async get(id: string): Promise<WorkspaceRecord | undefined> {
    return this.workspaces.get(id);
  }

  async listForSubject(subject: string): Promise<WorkspaceWithRole[]> {
    const out: Array<WorkspaceWithRole & { createdAt: string }> = [];
    for (const [wsId, m] of this.members) {
      const role = m.get(subject);
      if (!role) continue;
      const rec = this.workspaces.get(wsId);
      if (rec) out.push({ id: rec.id, name: rec.name, role, createdAt: rec.createdAt });
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return out.map(({ id, name, role }) => ({ id, name, role }));
  }

  async roleFor(workspace: string, subject: string): Promise<string | undefined> {
    return this.members.get(workspace)?.get(subject);
  }

  async ensureMembership(workspace: string, subject: string, role: string): Promise<void> {
    if (!this.workspaces.has(workspace))
      this.workspaces.set(workspace, { id: workspace, name: workspace, owner: subject, createdAt: nowIso() });
    this.setMember(workspace, subject, role, true);
  }

  private setMember(workspace: string, subject: string, role: string, onlyIfMissing: boolean): void {
    let m = this.members.get(workspace);
    if (!m) {
      m = new Map();
      this.members.set(workspace, m);
    }
    if (onlyIfMissing && m.has(subject)) return;
    m.set(subject, role);
  }
}

interface WorkspaceRow {
  id: string;
  name: string;
  owner: string;
  created_at: string | Date;
}

function toRecord(row: WorkspaceRow): WorkspaceRecord {
  return { id: row.id, name: row.name, owner: row.owner, createdAt: new Date(row.created_at).toISOString() };
}

export class PgWorkspaceStore implements WorkspaceStore {
  constructor(private readonly client: SqlClient) {}

  async create(rec: { id: string; name: string; owner: string }): Promise<WorkspaceRecord | undefined> {
    const res = await this.client.query<WorkspaceRow>(
      "INSERT INTO assay_workspaces (id, name, owner) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING id, name, owner, created_at",
      [rec.id, rec.name, rec.owner],
    );
    const row = res.rows[0];
    if (!row) return undefined; // id 충돌
    await this.client.query(
      "INSERT INTO assay_workspace_members (workspace, subject, role) VALUES ($1, $2, 'admin') ON CONFLICT (workspace, subject) DO NOTHING",
      [rec.id, rec.owner],
    );
    return toRecord(row);
  }

  async get(id: string): Promise<WorkspaceRecord | undefined> {
    const res = await this.client.query<WorkspaceRow>(
      "SELECT id, name, owner, created_at FROM assay_workspaces WHERE id = $1",
      [id],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : undefined;
  }

  async listForSubject(subject: string): Promise<WorkspaceWithRole[]> {
    const res = await this.client.query<{ id: string; name: string; role: string }>(
      "SELECT w.id, w.name, m.role FROM assay_workspace_members m JOIN assay_workspaces w ON w.id = m.workspace WHERE m.subject = $1 ORDER BY w.created_at ASC, w.id ASC",
      [subject],
    );
    return res.rows.map((r) => ({ id: r.id, name: r.name, role: r.role }));
  }

  async roleFor(workspace: string, subject: string): Promise<string | undefined> {
    const res = await this.client.query<{ role: string }>(
      "SELECT role FROM assay_workspace_members WHERE workspace = $1 AND subject = $2",
      [workspace, subject],
    );
    return res.rows[0]?.role;
  }

  async ensureMembership(workspace: string, subject: string, role: string): Promise<void> {
    await this.client.query(
      "INSERT INTO assay_workspaces (id, name, owner) VALUES ($1, $1, $2) ON CONFLICT (id) DO NOTHING",
      [workspace, subject],
    );
    await this.client.query(
      "INSERT INTO assay_workspace_members (workspace, subject, role) VALUES ($1, $2, $3) ON CONFLICT (workspace, subject) DO NOTHING",
      [workspace, subject, role],
    );
  }
}
