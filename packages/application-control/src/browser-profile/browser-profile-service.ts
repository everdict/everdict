import { type BrowserProfileRecord, NotFoundError } from "@everdict/contracts";
import type { BrowserProfileStore } from "../ports/browser-profile-store.js";

// Saved authenticated browser profile CRUD (browser-profiles S2). Personal / self-scoped: every read/write is
// gated on the owner subject — a profile owned by another subject is invisible (404, no existence leak), and there
// is no admin override (a profile holds personal login material). S3 adds cookie capture into the profile, S4 geo
// proxy, S5 injection into evals. Design: docs/architecture/browser-profiles.md.
export interface CreateBrowserProfileInput {
  tenant: string;
  createdBy: string;
  name: string;
  cookieDomains?: string[];
}

export interface UpdateBrowserProfileInput {
  name?: string;
  cookieDomains?: string[];
}

export interface BrowserProfileServiceDeps {
  store: BrowserProfileStore;
  newId?: () => string;
  now?: () => string;
}

export class BrowserProfileService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: BrowserProfileServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateBrowserProfileInput): Promise<BrowserProfileRecord> {
    const ts = this.now();
    const record: BrowserProfileRecord = {
      id: this.newId(),
      tenant: input.tenant,
      name: input.name,
      cookieDomains: input.cookieDomains ?? [],
      createdBy: input.createdBy,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    return record;
  }

  // My profiles only.
  list(tenant: string, subject: string): Promise<BrowserProfileRecord[]> {
    return this.deps.store.listOwned(tenant, subject);
  }

  // A single profile I own — otherwise 404 (no existence leak).
  async get(tenant: string, id: string, subject: string): Promise<BrowserProfileRecord> {
    return this.ownedOrThrow(tenant, id, subject);
  }

  async update(
    tenant: string,
    id: string,
    patch: UpdateBrowserProfileInput,
    subject: string,
  ): Promise<BrowserProfileRecord> {
    await this.ownedOrThrow(tenant, id, subject); // owner gate before the write
    const next: Partial<BrowserProfileRecord> = { updatedAt: this.now() };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.cookieDomains !== undefined) next.cookieDomains = patch.cookieDomains;
    const updated = await this.deps.store.update(tenant, id, next);
    if (!updated) throw new NotFoundError("NOT_FOUND", { id }, `browser profile '${id}' not found.`);
    return updated;
  }

  async remove(tenant: string, id: string, subject: string): Promise<void> {
    await this.ownedOrThrow(tenant, id, subject);
    await this.deps.store.remove(tenant, id);
  }

  private async ownedOrThrow(tenant: string, id: string, subject: string): Promise<BrowserProfileRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record || record.createdBy !== subject)
      throw new NotFoundError("NOT_FOUND", { id }, `browser profile '${id}' not found.`);
    return record;
  }
}
