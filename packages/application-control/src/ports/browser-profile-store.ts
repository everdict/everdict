import type { BrowserProfileRecord } from "@everdict/contracts";

// Persistence port for saved authenticated browser profiles (browser-profiles S2). Personal / self-scoped —
// listing is by owner subject; a profile is never visible across owners. Impls: InMemory / Pg in @everdict/db.
export interface BrowserProfileStore {
  create(record: BrowserProfileRecord): Promise<void>;
  get(tenant: string, id: string): Promise<BrowserProfileRecord | undefined>;
  listOwned(tenant: string, subject: string): Promise<BrowserProfileRecord[]>;
  update(tenant: string, id: string, patch: Partial<BrowserProfileRecord>): Promise<BrowserProfileRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
  // Persist a captured login (browser-profiles S3): the OPAQUE encrypted storageState blob (the store does no crypto
  // — the apps/api capture service encrypts) + capturedAt + the refined cookieDomains. Returns the updated record
  // (never containing the cipher — server-only).
  saveState(
    tenant: string,
    id: string,
    stateCipher: string,
    capturedAt: string,
    cookieDomains: string[],
  ): Promise<BrowserProfileRecord | undefined>;
  // Read back the opaque encrypted blob (decrypted by the caller) — used to inject the login into an eval (S5).
  loadState(tenant: string, id: string): Promise<string | undefined>;
}
