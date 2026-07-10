import type { ConsumeOutcome, CreateInviteInput, WorkspaceInviteMeta } from "@everdict/contracts";

export interface WorkspaceInviteStore {
  createInvite(input: CreateInviteInput): Promise<WorkspaceInviteMeta>;
  listInvites(workspace: string): Promise<WorkspaceInviteMeta[]>; // meta only — never returns token_hash
  revokeInvite(workspace: string, id: string): Promise<void>; // tenant-scoped, idempotent (no-op)
  // Atomic: verify exists+unexpired+unaccepted → create membership/refresh email → mark the invite accepted.
  consumeInvite(tokenHash: string, subject: string, email?: string): Promise<ConsumeOutcome>;
  // Non-consuming preview — by token hash, only workspace/role (no membership creation·redeem). Nonexistent/expired/accepted → undefined.
  previewInvite(tokenHash: string): Promise<{ workspace: string; role: string } | undefined>;
}
