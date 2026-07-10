import type { EverdictRole, Principal } from "@everdict/auth";
import { BadRequestError, ConflictError, NotFoundError } from "@everdict/core";
import type {
  MemberRecord,
  UserProfileStore,
  WorkspaceInviteMeta,
  WorkspaceInviteStore,
  WorkspaceStore,
} from "@everdict/db";
import { generateInviteToken, hashKey } from "@everdict/db";
import { MembershipPolicy } from "./membership-policy.js";

// Membership management service — a single core (parity) shared by the HTTP routes and MCP tools. The last-admin
// invariant is owned by MembershipPolicy (one implementation, three call sites); the service keeps orchestration
// (store calls, profile enrichment, the removal hook).
// Member = the workspace user graph. Invite = token/link redemption (joining). The workspace scope is passed in by the caller (principal.workspace).
export class MembershipService {
  private readonly policy = new MembershipPolicy();

  constructor(
    private readonly members: WorkspaceStore,
    private readonly invites: WorkspaceInviteStore,
    private readonly profiles: UserProfileStore,
    // Called right after a member is removed from / leaves the workspace (best-effort) — a cleanup hook, e.g. auto-disabling scheduled (cron) evals.
    // Failure never affects the member-removal result (the store is the source of truth). Shared HTTP/MCP core, so it applies to both.
    private readonly onMemberRemoved?: (workspace: string, subject: string) => Promise<unknown>,
  ) {}

  // --- Members ---
  // Enrich the opaque subject with a human-readable profile (name/avatar) — membership and profile are separate stores, so we join them here.
  // Shared BFF/MCP core, so both HTTP (GET /members) and MCP (list_members) carry the same name/avatar.
  async listMembers(workspace: string): Promise<MemberRecord[]> {
    const members = await this.members.listMembers(workspace);
    if (members.length === 0) return members;
    const profiles = await this.profiles.getMany(members.map((m) => m.subject));
    const bySubject = new Map(profiles.map((p) => [p.subject, p]));
    return members.map((m) => {
      const p = bySubject.get(m.subject);
      if (!p) return m;
      return {
        ...m,
        ...(p.name !== undefined ? { name: p.name } : {}),
        ...(p.avatarUrl !== undefined ? { avatarUrl: p.avatarUrl } : {}),
      };
    });
  }

  // Change an existing member's role. 404 if not a member. Demoting the last admin is forbidden (409).
  // NOTE: a race between listMembers→setRole (two concurrent admin demotions → 0 admins) is possible — admin counts are small, so allowed for v1. Harden with an atomic guard later.
  async setRole(workspace: string, subject: string, role: EverdictRole): Promise<void> {
    const all = await this.members.listMembers(workspace);
    const target = all.find((m) => m.subject === subject);
    if (!target) throw new NotFoundError("NOT_FOUND", { subject }, "Member not found.");
    this.policy.assertNotLastAdminDemotion(workspace, all, target, role);
    await this.members.setRole(workspace, subject, role);
  }

  // Remove a member (idempotent — no-op if absent, no existence leak). Removing the last admin is forbidden (409).
  async removeMember(workspace: string, subject: string): Promise<void> {
    const all = await this.members.listMembers(workspace);
    const target = all.find((m) => m.subject === subject);
    if (!target) return;
    this.policy.assertNotLastAdminRemoval(workspace, all, target);
    await this.members.removeMember(workspace, subject);
    await this.onMemberRemoved?.(workspace, subject).catch(() => {}); // cleanup hook (auto-disable scheduled evals) — best-effort
  }

  // I leave this workspace (self-serve — no role gate, removes only my own membership). Idempotent.
  // The last admin cannot leave (409) — you must first delegate admin to another member or delete the workspace.
  async leaveWorkspace(workspace: string, subject: string): Promise<void> {
    const all = await this.members.listMembers(workspace);
    const me = all.find((m) => m.subject === subject);
    if (!me) return; // not a member — idempotent
    this.policy.assertCanLeave(workspace, all, me);
    await this.members.removeMember(workspace, subject);
    await this.onMemberRemoved?.(workspace, subject).catch(() => {}); // cleanup hook (auto-disable scheduled evals) — best-effort
  }

  // --- Invites ---
  // Create an invite — returns the plaintext token exactly once (embedded in the link). Only the hash is stored (in the store).
  async createInvite(input: {
    workspace: string;
    role: EverdictRole;
    createdBy: string;
    expiresInHours?: number;
  }): Promise<{ token: string; meta: WorkspaceInviteMeta }> {
    const token = generateInviteToken();
    const expiresAt =
      input.expiresInHours !== undefined
        ? new Date(Date.now() + input.expiresInHours * 3_600_000).toISOString()
        : undefined;
    const meta = await this.invites.createInvite({
      workspace: input.workspace,
      role: input.role,
      createdBy: input.createdBy,
      tokenHash: hashKey(token),
      prefix: token.slice(0, 12),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
    return { token, meta };
  }

  listInvites(workspace: string): Promise<WorkspaceInviteMeta[]> {
    return this.invites.listInvites(workspace);
  }

  revokeInvite(workspace: string, id: string): Promise<void> {
    return this.invites.revokeInvite(workspace, id);
  }

  // Accept an invite — no workspace-role gate (this precedes joining). Only an authenticated human (OIDC) subject; a machine key (via !== 'oidc') is rejected.
  async acceptInvite(
    principal: { subject: string; via: Principal["via"]; email?: string },
    token: string,
  ): Promise<{ workspace: string; role: string }> {
    if (principal.via !== "oidc")
      throw new BadRequestError("BAD_REQUEST", undefined, "Sign in with a human account (OIDC) to accept the invite.");
    const r = await this.invites.consumeInvite(hashKey(token), principal.subject, principal.email);
    if (r.ok) return r.result;
    if (r.reason === "accepted") throw new ConflictError("CONFLICT", undefined, "This invite has already been used.");
    if (r.reason === "expired") throw new BadRequestError("BAD_REQUEST", undefined, "This invite has expired.");
    throw new NotFoundError("NOT_FOUND", undefined, "This invite is invalid."); // unknown == revoked (no existence leak)
  }

  // Invite preview (non-consuming) — returns only name/logo/role so the link landing can show "which workspace" this is.
  // Does not redeem and does not create a membership. Expired/accepted/revoked/invalid all fold into 404 (no existence leak). The token is itself the secret, so no auth gate.
  async previewInvite(token: string): Promise<{ workspace: string; name: string; logoUrl?: string; role: string }> {
    const found = await this.invites.previewInvite(hashKey(token));
    if (!found) throw new NotFoundError("NOT_FOUND", undefined, "This invite is invalid.");
    const ws = await this.members.get(found.workspace);
    if (!ws) throw new NotFoundError("NOT_FOUND", undefined, "This invite is invalid.");
    return {
      workspace: found.workspace,
      name: ws.name,
      role: found.role,
      ...(ws.logoUrl !== undefined ? { logoUrl: ws.logoUrl } : {}),
    };
  }
}
