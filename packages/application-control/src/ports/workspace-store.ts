import type { MemberRecord, WorkspaceRecord, WorkspaceWithRole } from "@everdict/contracts";

// Workspace membership store — which workspace a subject (user sub/key) belongs to with which role.
// workspace === tenant === trust-zone key. The control plane is the membership SSOT (the token claim is merely a bootstrap default).
// No plaintext/secrets — a pure membership graph. The role → action mapping is handled by @everdict/auth's authz.
// email is a cache of OIDC claims (email/preferred_username) — display only, to supplement the opaque subject, no authz bearing.
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
