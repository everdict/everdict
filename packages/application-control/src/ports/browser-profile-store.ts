import type { BrowserProfileRecord } from "@everdict/contracts";

// Persistence port for saved authenticated browser profiles (browser-profiles S2). Personal / self-scoped —
// listing is by owner subject; a profile is never visible across owners. Impls: InMemory / Pg in @everdict/db.
export interface BrowserProfileStore {
  create(record: BrowserProfileRecord): Promise<void>;
  get(tenant: string, id: string): Promise<BrowserProfileRecord | undefined>;
  listOwned(tenant: string, subject: string): Promise<BrowserProfileRecord[]>;
  update(tenant: string, id: string, patch: Partial<BrowserProfileRecord>): Promise<BrowserProfileRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}
