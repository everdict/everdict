import { randomBytes, randomUUID } from "node:crypto";
import type { SqlClient } from "../client.js";
import { hashKey } from "./tenant-auth.js";
import type { WorkspaceStore } from "./workspace-store.js";

// Workspace invite (token/link redemption) store — never stores the plaintext token, keeps only the SHA-256 hash (same as tenant-keys).
// Invite = join secret: hash-only · expiring · single-use. consume is atomic via a single CTE (since SqlClient has no transactions).
export { hashKey }; // reused when the service hashes the plaintext token and passes it in

export interface WorkspaceInviteMeta {
  id: string;
  workspace: string;
  role: string;
  createdBy: string;
  prefix: string; // inv_abcd… identification hint (not a hash/plaintext)
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

// Acceptance result — distinguishes the failure reason (the service maps it to an AppError). The reason isn't exposed as-is to the client (preventing existence leaks is the service's job).
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
  listInvites(workspace: string): Promise<WorkspaceInviteMeta[]>; // meta only — never returns token_hash
  revokeInvite(workspace: string, id: string): Promise<void>; // tenant-scoped, idempotent (no-op)
  // Atomic: verify exists+unexpired+unaccepted → create membership/refresh email → mark the invite accepted.
  consumeInvite(tokenHash: string, subject: string, email?: string): Promise<ConsumeOutcome>;
  // Non-consuming preview — by token hash, only workspace/role (no membership creation·redeem). Nonexistent/expired/accepted → undefined.
  previewInvite(tokenHash: string): Promise<{ workspace: string; role: string } | undefined>;
}

// inv_<random> — plaintext invite token (embedded in the link). Shown once at creation and stored only as a hash.
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
    if (row.acceptedAt !== undefined) return { ok: false, reason: "accepted" };
    if (row.expiresAt !== undefined && row.expiresAt <= this.now()) return { ok: false, reason: "expired" };
    row.acceptedAt = this.now();
    row.acceptedBy = subject;
    await this.members.ensureMembership(row.workspace, subject, row.role, email);
    // If already a member, the role is kept, so read back the actual role (prevents a shared link from changing permissions).
    const finalRole = (await this.members.roleFor(row.workspace, subject)) ?? row.role;
    return { ok: true, result: { workspace: row.workspace, role: finalRole } };
  }

  async previewInvite(tokenHash: string): Promise<{ workspace: string; role: string } | undefined> {
    const row = this.byHash.get(tokenHash);
    if (!row || row.acceptedAt !== undefined) return undefined;
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
      accepted: false,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
  }

  async listInvites(workspace: string): Promise<WorkspaceInviteMeta[]> {
    // Don't select token_hash (never expose it).
    const res = await this.client.query<InviteMetaRow>(
      `SELECT id, workspace, role, created_by, prefix, created_at, expires_at, accepted_at, accepted_by
       FROM everdict_workspace_invites WHERE workspace = $1 ORDER BY created_at DESC`,
      [workspace],
    );
    return res.rows.map(rowToMeta);
  }

  async revokeInvite(workspace: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_workspace_invites WHERE workspace = $1 AND id = $2", [workspace, id]);
  }

  async consumeInvite(tokenHash: string, subject: string, email?: string): Promise<ConsumeOutcome> {
    // Single CTE = atomic. accepted_at IS NULL is the single-use lock (concurrent redeem: the second gets 0 rows).
    // An existing member keeps their role (only email is COALESCE-refreshed) — so a shared link doesn't change permissions.
    const res = await this.client.query<{ workspace: string; role: string }>(
      `WITH claimed AS (
         UPDATE everdict_workspace_invites SET accepted_at = now(), accepted_by = $2
          WHERE token_hash = $1 AND accepted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
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
    const why = await this.client.query<{ accepted_at: string | Date | null; expires_at: string | Date | null }>(
      "SELECT accepted_at, expires_at FROM everdict_workspace_invites WHERE token_hash = $1",
      [tokenHash],
    );
    const w = why.rows[0];
    if (!w) return { ok: false, reason: "unknown" }; // absent == revoked (not distinguished)
    if (w.accepted_at !== null) return { ok: false, reason: "accepted" };
    return { ok: false, reason: "expired" };
  }

  async previewInvite(tokenHash: string): Promise<{ workspace: string; role: string } | undefined> {
    // Looks up by token_hash only and doesn't redeem. Unaccepted·unexpired rows only.
    const res = await this.client.query<{ workspace: string; role: string }>(
      `SELECT workspace, role FROM everdict_workspace_invites
        WHERE token_hash = $1 AND accepted_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [tokenHash],
    );
    const row = res.rows[0];
    return row ? { workspace: row.workspace, role: row.role } : undefined;
  }
}
