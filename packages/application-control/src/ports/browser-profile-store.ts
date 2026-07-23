import type { BrowserProfileRecord } from "@everdict/contracts";

// Persistence port for saved authenticated browser profiles (browser-profiles S2). Dual-scoped: a profile is either
// `private` (personal, creator-only) or `workspace` (a shared workspace asset). `list` returns what a caller can see
// — every workspace profile in the tenant plus the caller's own private ones (mirrors ViewStore.listVisible); the
// per-visibility manage gate lives in the service. Impls: InMemory / Pg in @everdict/db.
export interface BrowserProfileStore {
  create(record: BrowserProfileRecord): Promise<void>;
  get(tenant: string, id: string): Promise<BrowserProfileRecord | undefined>;
  list(tenant: string, subject: string): Promise<BrowserProfileRecord[]>;
  update(tenant: string, id: string, patch: Partial<BrowserProfileRecord>): Promise<BrowserProfileRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
  // Persist a captured login (browser-profiles S3): the OPAQUE encrypted storageState blob (the store does no crypto
  // — the apps/api capture service encrypts) + capturedAt + the refined cookieDomains + expiresAt (the earliest
  // cookie expiry, or null for a session-only / empty login — the capture service computes it from the plaintext
  // cookies the store never sees). Returns the updated record (never containing the cipher — server-only).
  saveState(
    tenant: string,
    id: string,
    stateCipher: string,
    capturedAt: string,
    cookieDomains: string[],
    expiresAt: string | null,
  ): Promise<BrowserProfileRecord | undefined>;
  // Read back the opaque encrypted blob (decrypted by the caller) — used to inject the login into an eval (S5).
  loadState(tenant: string, id: string): Promise<string | undefined>;
}
