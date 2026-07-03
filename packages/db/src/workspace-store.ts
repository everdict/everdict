import type { SqlClient } from "./client.js";

// 워크스페이스 멤버십 저장소 — subject(유저 sub/키)가 어떤 workspace 에 어떤 role 로 속하는지.
// workspace === tenant === trust-zone 키. 컨트롤플레인이 멤버십의 SSOT(토큰 클레임은 부트스트랩 기본값일 뿐).
// 평문/비밀 없음 — 순수 멤버십 그래프. role → action 매핑은 @assay/auth 의 authz 가 담당한다.
// email 은 OIDC 클레임(email/preferred_username) 캐시 — opaque subject 보완 표시 전용, authz 무관.
export interface WorkspaceRecord {
  id: string; // = tenant 키(모든 데이터 스코프)
  name: string; // 표시 이름
  owner: string; // 생성한 subject
  logoUrl?: string; // 로고(아바타와 동일: http(s) URL 또는 data:image base64)
  createdAt: string;
}

// 특정 subject 관점의 워크스페이스(그 subject 의 멤버십 역할 포함).
export interface WorkspaceWithRole {
  id: string;
  name: string;
  role: string;
  logoUrl?: string; // 사이드바/스위처 표시용
}

// 워크스페이스 멤버(역할 + 표시용 email + 가입시각). 멤버 관리 UI 표시용.
// name/avatarUrl 은 멤버십 스토어가 아니라 프로필(assay_user_profiles)을 합쳐 보강하는 필드 —
// WorkspaceStore 는 비워 두고 MembershipService 가 채운다(opaque subject 대신 사람이 읽는 신원 표시용).
export interface MemberRecord {
  subject: string;
  role: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  addedAt: string;
}

export interface WorkspaceStore {
  // 워크스페이스 생성 + 생성자를 admin 멤버로. id 충돌 시 undefined(서비스가 ConflictError 로 매핑).
  create(rec: { id: string; name: string; owner: string }): Promise<WorkspaceRecord | undefined>;
  get(id: string): Promise<WorkspaceRecord | undefined>;
  // subject 가 멤버인 워크스페이스 목록(역할 포함), 생성 시각 오름차순.
  listForSubject(subject: string): Promise<WorkspaceWithRole[]>;
  // 표시 정보 갱신(이름/로고). slug(id)는 불변. 없으면 undefined. logoUrl=null 은 로고 제거.
  update(id: string, patch: { name?: string; logoUrl?: string | null }): Promise<WorkspaceRecord | undefined>;
  // 워크스페이스 + 그 모든 workspace/tenant 스코프 데이터를 하드 삭제(cascade). 멱등(없으면 no-op).
  delete(id: string): Promise<void>;
  // (workspace, subject) 멤버십 역할 — 멤버가 아니면 undefined.
  roleFor(workspace: string, subject: string): Promise<string | undefined>;
  // 멱등 부트스트랩: 워크스페이스 + 멤버십을 없을 때만 만든다(기존 토큰/dev workspace 를 멤버십으로 승격).
  // 이미 멤버면 role 은 유지(admin 강등 금지)하고 email 만 갱신(null 로 기존값 덮어쓰지 않음 — COALESCE).
  ensureMembership(workspace: string, subject: string, role: string, email?: string): Promise<void>;
  // 멤버 목록(가입시각 오름차순). admin 표시용.
  listMembers(workspace: string): Promise<MemberRecord[]>;
  // 기존 멤버의 역할만 변경. 멤버가 아니면 false(가입은 초대로만 — 여기서 생성하지 않음). 도메인 에러는 서비스가 던진다.
  setRole(workspace: string, subject: string, role: string): Promise<boolean>;
  // 멤버 제거(멱등 — 없으면 no-op, 존재 누출 없음).
  removeMember(workspace: string, subject: string): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

interface MemberCell {
  role: string;
  email?: string;
  addedAt: string;
}

export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly members = new Map<string, Map<string, MemberCell>>(); // workspace → (subject → cell)

  async create(rec: { id: string; name: string; owner: string }): Promise<WorkspaceRecord | undefined> {
    if (this.workspaces.has(rec.id)) return undefined;
    const full: WorkspaceRecord = { ...rec, createdAt: nowIso() };
    this.workspaces.set(rec.id, full);
    this.cell(rec.id).set(rec.owner, { role: "admin", addedAt: nowIso() });
    return full;
  }

  async get(id: string): Promise<WorkspaceRecord | undefined> {
    return this.workspaces.get(id);
  }

  async listForSubject(subject: string): Promise<WorkspaceWithRole[]> {
    const out: Array<WorkspaceWithRole & { createdAt: string }> = [];
    for (const [wsId, m] of this.members) {
      const cell = m.get(subject);
      if (!cell) continue;
      const rec = this.workspaces.get(wsId);
      if (rec)
        out.push({
          id: rec.id,
          name: rec.name,
          role: cell.role,
          createdAt: rec.createdAt,
          ...(rec.logoUrl !== undefined ? { logoUrl: rec.logoUrl } : {}),
        });
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return out.map(({ id, name, role, logoUrl }) => ({
      id,
      name,
      role,
      ...(logoUrl !== undefined ? { logoUrl } : {}),
    }));
  }

  async update(id: string, patch: { name?: string; logoUrl?: string | null }): Promise<WorkspaceRecord | undefined> {
    const rec = this.workspaces.get(id);
    if (!rec) return undefined;
    // logoUrl: null=제거(undefined), 문자열=설정, undefined=유지. 키를 지우지 않고 spread-conditional 로 깔끔히 재구성.
    const logoUrl = patch.logoUrl === null ? undefined : (patch.logoUrl ?? rec.logoUrl);
    const next: WorkspaceRecord = {
      id: rec.id,
      name: patch.name !== undefined ? patch.name : rec.name,
      owner: rec.owner,
      createdAt: rec.createdAt,
      ...(logoUrl !== undefined ? { logoUrl } : {}),
    };
    this.workspaces.set(id, next);
    return next;
  }

  // in-memory 는 멤버십 그래프만 보유 — 다른 in-memory 스토어(secrets/runs 등)는 프로세스 로컬·도달 불가라 무해.
  async delete(id: string): Promise<void> {
    this.workspaces.delete(id);
    this.members.delete(id);
  }

  async roleFor(workspace: string, subject: string): Promise<string | undefined> {
    return this.members.get(workspace)?.get(subject)?.role;
  }

  async ensureMembership(workspace: string, subject: string, role: string, email?: string): Promise<void> {
    if (!this.workspaces.has(workspace))
      this.workspaces.set(workspace, { id: workspace, name: workspace, owner: subject, createdAt: nowIso() });
    const m = this.cell(workspace);
    const existing = m.get(subject);
    if (existing) {
      if (email !== undefined) existing.email = email; // role 유지, email 만 갱신
    } else {
      m.set(subject, { role, addedAt: nowIso(), ...(email !== undefined ? { email } : {}) });
    }
  }

  async listMembers(workspace: string): Promise<MemberRecord[]> {
    const m = this.members.get(workspace);
    if (!m) return [];
    return [...m.entries()]
      .map(([subject, c]) => ({
        subject,
        role: c.role,
        addedAt: c.addedAt,
        ...(c.email !== undefined ? { email: c.email } : {}),
      }))
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.subject.localeCompare(b.subject));
  }

  async setRole(workspace: string, subject: string, role: string): Promise<boolean> {
    const cell = this.members.get(workspace)?.get(subject);
    if (!cell) return false;
    cell.role = role;
    return true;
  }

  async removeMember(workspace: string, subject: string): Promise<void> {
    this.members.get(workspace)?.delete(subject);
  }

  private cell(workspace: string): Map<string, MemberCell> {
    let m = this.members.get(workspace);
    if (!m) {
      m = new Map();
      this.members.set(workspace, m);
    }
    return m;
  }
}

interface WorkspaceRow {
  id: string;
  name: string;
  owner: string;
  logo_url: string | null;
  created_at: string | Date;
}

function toRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.logo_url !== null ? { logoUrl: row.logo_url } : {}),
  };
}

// 워크스페이스 + 그 모든 스코프 데이터를 지우기 위한 (테이블, 스코프컬럼) 목록. assay_workspaces 는 별도로 마지막에.
// 모든 마이그레이션이 @assay/db 소유라 테이블명 인지는 레이어 위반이 아니다. _shared 는 실제 id 와 절대 같지 않다.
const WORKSPACE_SCOPED_TABLES: ReadonlyArray<readonly [table: string, column: string]> = [
  ["assay_oauth_states", "workspace"],
  ["assay_workspace_invites", "workspace"],
  ["assay_connections", "workspace"],
  ["assay_secrets", "workspace"],
  ["assay_runs", "tenant"],
  ["assay_scorecards", "tenant"],
  ["assay_harnesses", "tenant"],
  ["assay_datasets", "tenant"],
  ["assay_judges", "tenant"],
  ["assay_runtimes", "tenant"],
  ["assay_benchmarks", "tenant"],
  ["assay_models", "tenant"],
  ["assay_harness_templates", "tenant"],
  ["assay_harness_instances", "tenant"],
  ["assay_tenant_keys", "tenant"],
  ["assay_workspace_settings", "workspace"],
  ["assay_workspace_members", "workspace"],
];

export class PgWorkspaceStore implements WorkspaceStore {
  constructor(private readonly client: SqlClient) {}

  async create(rec: { id: string; name: string; owner: string }): Promise<WorkspaceRecord | undefined> {
    const res = await this.client.query<WorkspaceRow>(
      "INSERT INTO assay_workspaces (id, name, owner) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING id, name, owner, logo_url, created_at",
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
      "SELECT id, name, owner, logo_url, created_at FROM assay_workspaces WHERE id = $1",
      [id],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : undefined;
  }

  async listForSubject(subject: string): Promise<WorkspaceWithRole[]> {
    const res = await this.client.query<{ id: string; name: string; role: string; logo_url: string | null }>(
      "SELECT w.id, w.name, m.role, w.logo_url FROM assay_workspace_members m JOIN assay_workspaces w ON w.id = m.workspace WHERE m.subject = $1 ORDER BY w.created_at ASC, w.id ASC",
      [subject],
    );
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      ...(r.logo_url !== null ? { logoUrl: r.logo_url } : {}),
    }));
  }

  async update(id: string, patch: { name?: string; logoUrl?: string | null }): Promise<WorkspaceRecord | undefined> {
    // name=COALESCE(유지), logo_url 은 명시 패치만 반영($3 sentinel 없이 3-상태): undefined=유지, null=지움, 값=설정.
    const setLogo = patch.logoUrl !== undefined; // undefined 면 logo_url 컬럼을 건드리지 않는다.
    const res = await this.client.query<WorkspaceRow>(
      `UPDATE assay_workspaces
         SET name = COALESCE($2, name)${setLogo ? ", logo_url = $3" : ""}
       WHERE id = $1
       RETURNING id, name, owner, logo_url, created_at`,
      setLogo ? [id, patch.name ?? null, patch.logoUrl] : [id, patch.name ?? null],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : undefined;
  }

  // 순차·멱등 cascade. assay_workspaces 를 마지막에 지워(그 전까진 재시도 가능) 부분 실패에도 안전.
  // SqlClient 는 트랜잭션 추상화가 없어 단일 BEGIN/COMMIT 을 보장할 수 없으므로 멱등 DELETE 로 처리한다.
  async delete(id: string): Promise<void> {
    for (const [table, column] of WORKSPACE_SCOPED_TABLES) {
      await this.client.query(`DELETE FROM ${table} WHERE ${column} = $1`, [id]);
    }
    await this.client.query("DELETE FROM assay_workspaces WHERE id = $1", [id]);
  }

  async roleFor(workspace: string, subject: string): Promise<string | undefined> {
    const res = await this.client.query<{ role: string }>(
      "SELECT role FROM assay_workspace_members WHERE workspace = $1 AND subject = $2",
      [workspace, subject],
    );
    return res.rows[0]?.role;
  }

  async ensureMembership(workspace: string, subject: string, role: string, email?: string): Promise<void> {
    await this.client.query(
      "INSERT INTO assay_workspaces (id, name, owner) VALUES ($1, $1, $2) ON CONFLICT (id) DO NOTHING",
      [workspace, subject],
    );
    // role 은 신규일 때만 적용(ON CONFLICT 시 유지 — admin 강등 금지). email 은 COALESCE 로 갱신/백필(null clobber 금지).
    await this.client.query(
      `INSERT INTO assay_workspace_members (workspace, subject, role, email) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace, subject) DO UPDATE SET email = COALESCE(EXCLUDED.email, assay_workspace_members.email)`,
      [workspace, subject, role, email ?? null],
    );
  }

  async listMembers(workspace: string): Promise<MemberRecord[]> {
    const res = await this.client.query<{
      subject: string;
      role: string;
      email: string | null;
      created_at: string | Date;
    }>(
      "SELECT subject, role, email, created_at FROM assay_workspace_members WHERE workspace = $1 ORDER BY created_at ASC, subject ASC",
      [workspace],
    );
    return res.rows.map((r) => ({
      subject: r.subject,
      role: r.role,
      addedAt: new Date(r.created_at).toISOString(),
      ...(r.email !== null ? { email: r.email } : {}),
    }));
  }

  async setRole(workspace: string, subject: string, role: string): Promise<boolean> {
    const res = await this.client.query<{ subject: string }>(
      "UPDATE assay_workspace_members SET role = $3 WHERE workspace = $1 AND subject = $2 RETURNING subject",
      [workspace, subject, role],
    );
    return res.rows.length > 0; // 멤버가 아니면 0행 → false
  }

  async removeMember(workspace: string, subject: string): Promise<void> {
    await this.client.query("DELETE FROM assay_workspace_members WHERE workspace = $1 AND subject = $2", [
      workspace,
      subject,
    ]);
  }
}
