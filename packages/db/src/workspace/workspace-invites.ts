import { randomUUID } from "node:crypto";
import { hashKey } from "@everdict/application-control";
import type { WorkspaceStore } from "@everdict/application-control";
import type { ConsumeOutcome, CreateInviteInput, WorkspaceInviteMeta } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

// Workspace invite (token/link redemption) store — never stores the plaintext token, keeps only the SHA-256 hash (same as tenant-keys).
// Invite = reusable join secret: hash-only · expiring · multi-use. A link stays valid until it expires or an admin
// revokes it; each acceptance bumps accepted_count. consume is atomic via a single CTE (since SqlClient has no transactions).
export { hashKey }; // reused when the service hashes the plaintext token and passes it in

import type { WorkspaceInviteStore } from "@everdict/application-control";

interface InviteRow {
  id: string;
  workspace: string;
  role: string;
  createdBy: string;
  prefix: string;
  createdAt: string;
  expiresAt?: string;
  acceptedCount: number;
}

function meta(r: InviteRow): WorkspaceInviteMeta {
  return {
    id: r.id,
    workspace: r.workspace,
    role: r.role,
    createdBy: r.createdBy,
    prefix: r.prefix,
    createdAt: r.createdAt,
    acceptedCount: r.acceptedCount,
    ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
  };
}

export class InMemoryWorkspaceInviteStore implements WorkspaceInviteStore {
  private readonly byHash = new Map<string, InviteRow>(); // tokenHash → row
  constructor(
    private readonly members: WorkspaceStore, // used to create/refresh membership on consume
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
      acceptedCount: 0,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
    this.byHash.set(input.tokenHash, row);
    return meta(row);
  }

  async listInvites(workspace: string): Promise<WorkspaceInviteMeta[]> {
    return [...this.byHash.values()]
      .filter((r) => r.workspace === workspace)
      .map(meta)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
  }

  async revokeInvite(workspace: string, id: string): Promise<void> {
    for (const [hash, r] of this.byHash) if (r.workspace === workspace && r.id === id) this.byHash.delete(hash);
  }

  async consumeInvite(tokenHash: string, subject: string, email?: string): Promise<ConsumeOutcome> {
    const row = this.byHash.get(tokenHash);
    if (!row) return { ok: false, reason: "unknown" };
    if (row.expiresAt !== undefined && row.expiresAt <= this.now()) return { ok: false, reason: "expired" };
    // Reusable: every acceptance joins and bumps the count; the link is not locked after the first use.
    row.acceptedCount += 1;
    await this.members.ensureMembership(row.workspace, subject, row.role, email);
    // If already a member, the role is kept, so read back the actual role (prevents a shared link from changing permissions).
    const finalRole = (await this.members.roleFor(row.workspace, subject)) ?? row.role;
    return { ok: true, result: { workspace: row.workspace, role: finalRole } };
  }

  async previewInvite(tokenHash: string): Promise<{ workspace: string; role: string } | undefined> {
    const row = this.byHash.get(tokenHash);
    if (!row) return undefined;
    if (row.expiresAt !== undefined && row.expiresAt <= this.now()) return undefined;
    return { workspace: row.workspace, role: row.role };
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
  accepted_count: number | string;
}

function rowToMeta(r: InviteMetaRow): WorkspaceInviteMeta {
  return {
    id: r.id,
    workspace: r.workspace,
    role: r.role,
    createdBy: r.created_by,
    prefix: r.prefix,
    createdAt: new Date(r.created_at).toISOString(),
    acceptedCount: Number(r.accepted_count),
    ...(r.expires_at !== null ? { expiresAt: new Date(r.expires_at).toISOString() } : {}),
  };
}

export class PgWorkspaceInviteStore implements WorkspaceInviteStore {
  constructor(private readonly client: SqlClient) {}

  async createInvite(input: CreateInviteInput): Promise<WorkspaceInviteMeta> {
    const id = randomUUID();
    const res = await this.client.query<{ created_at: string | Date }>(
      `INSERT INTO everdict_workspace_invites (token_hash, id, workspace, role, created_by, prefix, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING created_at`,
      [input.tokenHash, id, input.workspace, input.role, input.createdBy, input.prefix, input.expiresAt ?? null],
    );
    const r = res.rows[0];
    if (!r) throw new Error("invite insert did not return a row.");
    return {
      id,
      workspace: input.workspace,
      role: input.role,
      createdBy: input.createdBy,
      prefix: input.prefix,
      createdAt: new Date(r.created_at).toISOString(),
      acceptedCount: 0,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
  }

  async listInvites(workspace: string): Promise<WorkspaceInviteMeta[]> {
    // Don't select token_hash (never expose it).
    const res = await this.client.query<InviteMetaRow>(
      `SELECT id, workspace, role, created_by, prefix, created_at, expires_at, accepted_count
       FROM everdict_workspace_invites WHERE workspace = $1 ORDER BY created_at DESC`,
      [workspace],
    );
    return res.rows.map(rowToMeta);
  }

  async revokeInvite(workspace: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_workspace_invites WHERE workspace = $1 AND id = $2", [workspace, id]);
  }

  async consumeInvite(tokenHash: string, subject: string, email?: string): Promise<ConsumeOutcome> {
    // Single CTE = atomic. Reusable: no accepted_at lock — the link can be redeemed until it expires or is revoked;
    // each acceptance bumps accepted_count (row lock serializes concurrent redeems so the count is exact).
    // An existing member keeps their role (only email is COALESCE-refreshed) — so a shared link doesn't change permissions.
    const res = await this.client.query<{ workspace: string; role: string }>(
      `WITH claimed AS (
         UPDATE everdict_workspace_invites SET accepted_count = accepted_count + 1
          WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > now())
         RETURNING workspace, role
       ),
       member AS (
         INSERT INTO everdict_workspace_members (workspace, subject, role, email)
         SELECT workspace, $2, role, $3 FROM claimed
         ON CONFLICT (workspace, subject)
         DO UPDATE SET email = COALESCE(EXCLUDED.email, everdict_workspace_members.email)
         RETURNING workspace, role
       )
       SELECT workspace, role FROM member`,
      [tokenHash, subject, email ?? null],
    );
    const row = res.rows[0];
    if (row) return { ok: true, result: { workspace: row.workspace, role: row.role } };
    // Failure — a read-only follow-up classification (unrelated to the success-path atomicity).
    // A row that exists and is unexpired always succeeds above, so the only failures are absent (revoked) or expired.
    const why = await this.client.query<{ token_hash: string }>(
      "SELECT token_hash FROM everdict_workspace_invites WHERE token_hash = $1",
      [tokenHash],
    );
    if (!why.rows[0]) return { ok: false, reason: "unknown" }; // absent == revoked (not distinguished)
    return { ok: false, reason: "expired" };
  }

  async previewInvite(tokenHash: string): Promise<{ workspace: string; role: string } | undefined> {
    // Looks up by token_hash only and doesn't redeem. Unexpired rows only (a reusable link previews even after use).
    const res = await this.client.query<{ workspace: string; role: string }>(
      `SELECT workspace, role FROM everdict_workspace_invites
        WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > now())`,
      [tokenHash],
    );
    const row = res.rows[0];
    return row ? { workspace: row.workspace, role: row.role } : undefined;
  }
}
