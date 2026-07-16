import type { ConsumeOutcome, CreateInviteInput, WorkspaceInviteMeta } from "@everdict/contracts";

export interface WorkspaceInviteStore {
  createInvite(input: CreateInviteInput): Promise<WorkspaceInviteMeta>;
  listInvites(workspace: string): Promise<WorkspaceInviteMeta[]>; // meta only — never returns token_hash
  revokeInvite(workspace: string, id: string): Promise<void>; // tenant-scoped, idempotent (no-op)
  // Atomic: verify exists+unexpired → create membership/refresh email → bump the join count. Reusable (no single-use lock).
  consumeInvite(tokenHash: string, subject: string, email?: string): Promise<ConsumeOutcome>;
  // Non-consuming preview — by token hash, only workspace/role (no membership creation·redeem). Nonexistent/expired → undefined (a used-but-still-valid link previews).
  previewInvite(tokenHash: string): Promise<{ workspace: string; role: string } | undefined>;
}
