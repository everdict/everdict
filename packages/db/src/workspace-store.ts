import type { SqlClient } from "./client.js";

// Workspace membership store — which workspace a subject (user sub/key) belongs to with which role.
// workspace === tenant === trust-zone key. The control plane is the membership SSOT (the token claim is merely a bootstrap default).
// No plaintext/secrets — a pure membership graph. The role → action mapping is handled by @everdict/auth's authz.
// email is a cache of OIDC claims (email/preferred_username) — display only, to supplement the opaque subject, no authz bearing.
export interface WorkspaceRecord {
  id: string; // = tenant key (the scope of all data)
  name: string; // display name
  owner: string; // the subject who created it
  logoUrl?: string; // logo (same as avatar: http(s) URL or data:image base64)
  createdAt: string;
}

// A workspace from a specific subject's perspective (includes that subject's membership role).
export interface WorkspaceWithRole {
  id: string;
  name: string;
  role: string;
  logoUrl?: string; // for sidebar/switcher display
}

// A workspace member (role + display email + join time). For the member-management UI.
// name/avatarUrl are fields enriched by joining the profile (everdict_user_profiles), not the membership store —
// WorkspaceStore leaves them empty and MembershipService fills them (for a human-readable identity instead of the opaque subject).
export interface MemberRecord {
  subject: string;
  role: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  addedAt: string;
}

export interface WorkspaceStore {
  // Create a workspace + make the creator an admin member. undefined on id collision (the service maps it to ConflictError).
  create(rec: { id: string; name: string; owner: string }): Promise<WorkspaceRecord | undefined>;
  get(id: string): Promise<WorkspaceRecord | undefined>;
  // The workspaces the subject is a member of (with role), ascending by creation time.
  listForSubject(subject: string): Promise<WorkspaceWithRole[]>;
  // Update display info (name/logo). The slug (id) is immutable. undefined if not found. logoUrl=null removes the logo.
  update(id: string, patch: { name?: string; logoUrl?: string | null }): Promise<WorkspaceRecord | undefined>;
  // Hard-delete the workspace + all its workspace/tenant-scoped data (cascade). Idempotent (no-op if absent).
  delete(id: string): Promise<void>;
  // (workspace, subject) membership role — undefined if not a member.
  roleFor(workspace: string, subject: string): Promise<string | undefined>;
  // Idempotent bootstrap: create the workspace + membership only when absent (promotes an existing token/dev workspace to a membership).
  // If already a member, keep the role (no admin demotion) and only refresh email (never clobber the existing value with null — COALESCE).
  ensureMembership(workspace: string, subject: string, role: string, email?: string): Promise<void>;
  // Member list (ascending by join time). For admin display.
  listMembers(workspace: string): Promise<MemberRecord[]>;
  // Change only an existing member's role. false if not a member (joining is invite-only — nothing is created here). Domain errors are thrown by the service.
  setRole(workspace: string, subject: string, role: string): Promise<boolean>;
  // Remove a member (idempotent — no-op if absent, no existence leak).
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
    // logoUrl: null=remove (undefined), string=set, undefined=keep. Cleanly rebuild via spread-conditional without deleting the key.
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

  // in-memory holds only the membership graph — other in-memory stores (secrets/runs etc.) are process-local and unreachable, so harmless.
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
      if (email !== undefined) existing.email = email; // keep role, refresh only email
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

// The (table, scope-column) list used to delete a workspace + all its scoped data. everdict_workspaces is done separately, last.
// All migrations are owned by @everdict/db, so knowing table names is not a layer violation. _shared is never equal to a real id.
const WORKSPACE_SCOPED_TABLES: ReadonlyArray<readonly [table: string, column: string]> = [
  ["everdict_oauth_states", "workspace"],
  ["everdict_workspace_invites", "workspace"],
  ["everdict_connections", "workspace"],
  ["everdict_secrets", "workspace"],
  ["everdict_runs", "tenant"],
  ["everdict_scorecards", "tenant"],
  ["everdict_harnesses", "tenant"],
  ["everdict_datasets", "tenant"],
  ["everdict_judges", "tenant"],
  ["everdict_runtimes", "tenant"],
  ["everdict_benchmarks", "tenant"],
  ["everdict_models", "tenant"],
  ["everdict_harness_templates", "tenant"],
  ["everdict_harness_instances", "tenant"],
  ["everdict_tenant_keys", "tenant"],
  ["everdict_workspace_settings", "workspace"],
  ["everdict_workspace_members", "workspace"],
];

export class PgWorkspaceStore implements WorkspaceStore {
  constructor(private readonly client: SqlClient) {}

  async create(rec: { id: string; name: string; owner: string }): Promise<WorkspaceRecord | undefined> {
    const res = await this.client.query<WorkspaceRow>(
      "INSERT INTO everdict_workspaces (id, name, owner) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING id, name, owner, logo_url, created_at",
      [rec.id, rec.name, rec.owner],
    );
    const row = res.rows[0];
    if (!row) return undefined; // id collision
    await this.client.query(
      "INSERT INTO everdict_workspace_members (workspace, subject, role) VALUES ($1, $2, 'admin') ON CONFLICT (workspace, subject) DO NOTHING",
      [rec.id, rec.owner],
    );
    return toRecord(row);
  }

  async get(id: string): Promise<WorkspaceRecord | undefined> {
    const res = await this.client.query<WorkspaceRow>(
      "SELECT id, name, owner, logo_url, created_at FROM everdict_workspaces WHERE id = $1",
      [id],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : undefined;
  }

  async listForSubject(subject: string): Promise<WorkspaceWithRole[]> {
    const res = await this.client.query<{ id: string; name: string; role: string; logo_url: string | null }>(
      "SELECT w.id, w.name, m.role, w.logo_url FROM everdict_workspace_members m JOIN everdict_workspaces w ON w.id = m.workspace WHERE m.subject = $1 ORDER BY w.created_at ASC, w.id ASC",
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
    // name=COALESCE (keep); logo_url reflects only an explicit patch (3-state without a $3 sentinel): undefined=keep, null=clear, value=set.
    const setLogo = patch.logoUrl !== undefined; // if undefined, don't touch the logo_url column.
    const res = await this.client.query<WorkspaceRow>(
      `UPDATE everdict_workspaces
         SET name = COALESCE($2, name)${setLogo ? ", logo_url = $3" : ""}
       WHERE id = $1
       RETURNING id, name, owner, logo_url, created_at`,
      setLogo ? [id, patch.name ?? null, patch.logoUrl] : [id, patch.name ?? null],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : undefined;
  }

  // Sequential, idempotent cascade. Delete everdict_workspaces last (retryable up to then), so it's safe even on partial failure.
  // SqlClient has no transaction abstraction and can't guarantee a single BEGIN/COMMIT, so this uses idempotent DELETEs.
  async delete(id: string): Promise<void> {
    for (const [table, column] of WORKSPACE_SCOPED_TABLES) {
      await this.client.query(`DELETE FROM ${table} WHERE ${column} = $1`, [id]);
    }
    await this.client.query("DELETE FROM everdict_workspaces WHERE id = $1", [id]);
  }

  async roleFor(workspace: string, subject: string): Promise<string | undefined> {
    const res = await this.client.query<{ role: string }>(
      "SELECT role FROM everdict_workspace_members WHERE workspace = $1 AND subject = $2",
      [workspace, subject],
    );
    return res.rows[0]?.role;
  }

  async ensureMembership(workspace: string, subject: string, role: string, email?: string): Promise<void> {
    await this.client.query(
      "INSERT INTO everdict_workspaces (id, name, owner) VALUES ($1, $1, $2) ON CONFLICT (id) DO NOTHING",
      [workspace, subject],
    );
    // role applies only when new (kept on ON CONFLICT — no admin demotion). email is refreshed/backfilled via COALESCE (no null clobber).
    await this.client.query(
      `INSERT INTO everdict_workspace_members (workspace, subject, role, email) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace, subject) DO UPDATE SET email = COALESCE(EXCLUDED.email, everdict_workspace_members.email)`,
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
      "SELECT subject, role, email, created_at FROM everdict_workspace_members WHERE workspace = $1 ORDER BY created_at ASC, subject ASC",
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
      "UPDATE everdict_workspace_members SET role = $3 WHERE workspace = $1 AND subject = $2 RETURNING subject",
      [workspace, subject, role],
    );
    return res.rows.length > 0; // not a member → 0 rows → false
  }

  async removeMember(workspace: string, subject: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_workspace_members WHERE workspace = $1 AND subject = $2", [
      workspace,
      subject,
    ]);
  }
}
