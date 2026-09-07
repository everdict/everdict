import type { MemberRecord, WorkspaceRecord, WorkspaceWithRole } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

// Workspace membership store — which workspace a subject (user sub/key) belongs to with which role.
// workspace === tenant === trust-zone key. The control plane is the membership SSOT (the token claim is merely a bootstrap default).
// No plaintext/secrets — a pure membership graph. The role → action mapping is handled by @everdict/auth's authz.
// email is a cache of OIDC claims (email/preferred_username) — display only, to supplement the opaque subject, no authz bearing.

import type { WorkspaceStore } from "@everdict/application-control";

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

// ── WHAT A WORKSPACE DELETE OWES, ASKED OF THE SCHEMA RATHER THAN REMEMBERED ─────────────────────
//
// This was a hand-maintained list of 18 `[table, column]` pairs. The migrations create 86 live tables and
// **55 of them carry a `workspace` or `tenant` column that the list never named** — agents and their
// sessions, messages and tasks; approvals; comments; budgets and usage; capabilities; environments; created
// worlds; execution attempts; fs revisions; the whole eval tracker; evolution campaigns, rounds, evidence
// and adoptions; envelopes; trajectories; skills; knowledge; subscriptions; schedules; notifications.
// The list predates most of the schema, every feature since has added tenant-scoped tables, and none of them
// added a line here because nothing asked.
//
// ⚠️ AND IT WAS NOT MERELY INCOMPLETE — IT WAS BROKEN. `everdict_connections` was dropped in migration
// `0046_drop_connections.sql` and stayed in this list, third from the top. On any database migrated past
// 0046 the third statement raises `relation "everdict_connections" does not exist`, so `delete()` REJECTS:
// `DELETE /workspace` answers 500, the workspace row is never removed, and the two tables above the dead
// entry have already had their rows deleted. Verified against a real Postgres migrated to head — the
// workspace, its members and an agent row all survived a delete that threw.
//
// So the set is DERIVED. `everdict_%` base tables in the current schema carrying a `workspace` or `tenant`
// column ARE the workspace's data, by construction; a table added tomorrow is swept without anybody
// remembering this file exists, and a table dropped yesterday cannot break the delete. It is the same repair
// `pnpm option-forwarding` demands one layer up — a rebuild that is an allowlist silently eats whatever was
// added after it was written, so the field names are read off the thing that owns them.
//
// A table that must NOT be swept says so HERE, once, with its reason. It is empty on purpose: retaining
// billing or audit rows past a workspace delete is a product decision nobody has made, and inventing one
// while fixing a sweep would be the wrong place to make it. An entry is `[table, why]`, and "why" means the
// reason the rows outlive the workspace, not the reason somebody was nervous.
const RETAINED_AFTER_DELETE: ReadonlyArray<readonly [table: string, why: string]> = [];

// The scope columns a tenant's rows are addressed by. Both spellings exist and no table carries both
// (checked across all 219 migrations), so one column per table is the whole answer.
const SCOPE_COLUMNS = ["workspace", "tenant"] as const;

interface ScopedTable {
  table: string;
  column: string;
}
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

  // Every `everdict_%` base table in the current schema that addresses rows by workspace or tenant, ordered
  // so a table referenced by another comes AFTER its children. Only four foreign keys exist among these today
  // and all four are `ON DELETE CASCADE`, so the order is currently redundant — it is here because the next
  // one might not be, and a sweep that depends on nobody adding a plain reference is the same kind of promise
  // this file just stopped making.
  private async scopedTables(): Promise<ScopedTable[]> {
    const columns = await this.client.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = current_schema()
          AND t.table_type = 'BASE TABLE'
          AND c.table_name LIKE 'everdict\\_%'
          AND c.column_name = ANY($1)`,
      [[...SCOPE_COLUMNS]],
    );
    const retained = new Set(RETAINED_AFTER_DELETE.map(([table]) => table));
    const scoped = new Map<string, ScopedTable>();
    for (const row of columns.rows) {
      if (retained.has(row.table_name)) continue;
      // The workspace row itself is deleted last, by id, after everything it owns.
      if (row.table_name === "everdict_workspaces") continue;
      scoped.set(row.table_name, { table: row.table_name, column: row.column_name });
    }
    // parent → the tables that reference it, so a referenced table is swept after the ones pointing at it.
    const refs = await this.client.query<{ child: string; parent: string }>(
      `SELECT child.relname AS child, parent.relname AS parent
         FROM pg_constraint con
         JOIN pg_class child ON child.oid = con.conrelid
         JOIN pg_class parent ON parent.oid = con.confrelid
        WHERE con.contype = 'f'`,
    );
    const after = new Map<string, Set<string>>();
    for (const { child, parent } of refs.rows) {
      if (child === parent || !scoped.has(child) || !scoped.has(parent)) continue;
      const set = after.get(parent) ?? new Set<string>();
      set.add(child);
      after.set(parent, set);
    }
    const ordered: ScopedTable[] = [];
    const placed = new Set<string>();
    const visit = (name: string, seen: Set<string>): void => {
      if (placed.has(name) || seen.has(name)) return; // a reference cycle keeps whatever order it had
      seen.add(name);
      for (const child of after.get(name) ?? []) visit(child, seen);
      const entry = scoped.get(name);
      if (entry !== undefined && !placed.has(name)) {
        placed.add(name);
        ordered.push(entry);
      }
    };
    for (const name of [...scoped.keys()].sort()) visit(name, new Set());
    return ordered;
  }

  // Sequential, idempotent cascade. Delete everdict_workspaces last (retryable up to then), so it's safe even on partial failure.
  // SqlClient has no transaction abstraction and can't guarantee a single BEGIN/COMMIT, so this uses idempotent DELETEs.
  async delete(id: string): Promise<void> {
    const tables = await this.scopedTables();
    // ⚠️ AN EMPTY SET IS NOT "NOTHING TO DELETE". This repository's own rule for a check — refuse to report
    // over an empty corpus — is a rule about a DECISION here: a schema query that came back with no
    // tenant-scoped tables means we could not enumerate what this delete owes, and deleting the workspace row
    // on top of that would report success over data nobody looked for (rule `protocol` L5 — a teardown that
    // could not enumerate what it owes has not enumerated zero).
    if (tables.length === 0)
      throw new Error(
        "workspace delete: no tenant-scoped tables resolved from the schema, so what this delete owes is unknown — refusing to remove the workspace row.",
      );
    for (const { table, column } of tables) {
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
