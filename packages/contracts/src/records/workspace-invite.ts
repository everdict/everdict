// Workspace invite record shapes — moved from @everdict/db workspace-invites in re-architecture P2c.
// The WorkspaceInviteStore interface + impls + generateInviteToken stay in @everdict/db.

export interface WorkspaceInviteMeta {
  id: string;
  workspace: string;
  role: string;
  createdBy: string;
  prefix: string; // inv_abcd… identification hint (not a hash/plaintext)
  createdAt: string;
  expiresAt?: string;
  acceptedCount: number; // reusable join link: how many people have joined via it (0 = unused). It stays valid until it expires or an admin revokes it.
}

export interface ConsumeResult {
  workspace: string;
  role: string;
}

// Acceptance result — distinguishes the failure reason (the service maps it to an AppError). The reason isn't exposed as-is to the client (preventing existence leaks is the service's job).
// A reusable invite has no "already used" failure: it can be redeemed repeatedly until it expires or is revoked.
export type ConsumeOutcome = { ok: true; result: ConsumeResult } | { ok: false; reason: "unknown" | "expired" };

export interface CreateInviteInput {
  workspace: string;
  role: string;
  createdBy: string;
  tokenHash: string;
  prefix: string;
  expiresAt?: string;
}
