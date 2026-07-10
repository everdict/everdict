import type { ResolvedKey, TenantKeyMeta } from "@everdict/contracts";

export interface TenantKeyStore {
  // If meta is unset (test/bootstrap), id is auto-generated, prefix is an empty string, scopes is unrestricted, owner is "" (machine key). issueKey is the formal issuance path.
  add(
    tenant: string,
    keyHash: string,
    meta?: { id?: string; label?: string; prefix?: string; scopes?: string[]; owner?: string },
  ): Promise<void>;
  resolveByHash(keyHash: string): Promise<ResolvedKey | undefined>; // auth path (invariant) — resolve workspace+issuer+scopes by hash
  // Meta only (no key_hash/plaintext). With owner, only that user's personal keys (self list); unset means the whole workspace (machine-key management).
  list(tenant: string, owner?: string): Promise<TenantKeyMeta[]>;
  // Tenant-scoped revoke — a no-op for a different workspace id. With owner, revokes only that owner's key (prevents revoking someone else's key).
  revoke(tenant: string, id: string, owner?: string): Promise<void>;
}
