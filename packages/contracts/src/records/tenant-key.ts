// Tenant API key record shapes — moved from @everdict/db tenant-auth in re-architecture P2c.
// The TenantKeyStore interface + impls + the crypto helpers (hashKey/generateKey/issueKey) stay in @everdict/db.

// Non-secret metadata for self-serve management (list/revoke) — never includes the key hash/plaintext.
//  - id     = stable identifier (to target a revoke; so key_hash is never exposed)
//  - label  = human-assigned name (optional)
//  - prefix = ak_abcd… (a leading-plaintext identification hint — not a hash/plaintext; used to tell keys apart in a list)
//  - scopes = per-key permission scope (read|write|admin). Unset (legacy row/full access) → undefined = unrestricted.
//             The permission matrix (scope→action) is owned by @everdict/auth (this is a dumb string store; avoids a cyclic dependency).
export interface TenantKeyMeta {
  id: string;
  label?: string;
  prefix: string;
  scopes?: string[];
  createdAt: string;
}

// Key-resolution result on the auth path — workspace + issuer (owner) + per-key scopes (if any).
// owner="" = legacy workspace machine key (admin), owner=<subject> = that user's personal key (resolved to the issuer's role).
export interface ResolvedKey {
  tenant: string;
  owner: string;
  scopes?: string[]; // unset (legacy/full access) → undefined = unrestricted
}
