import {
  type BrowserProfileRecord,
  type BrowserProfileVisibility,
  ForbiddenError,
  NotFoundError,
} from "@everdict/contracts";
import type { BrowserProfileStore } from "../ports/browser-profile-store.js";

// Saved authenticated browser profile CRUD (browser-profiles S2). Dual-scoped, like Views:
//   - `private` (default) = a personal profile, visible and manageable only by its creator (user scope — the right
//     default for personal login material; NO admin override, even for management).
//   - `workspace` = a shared workspace asset: read by any member, managed by the creator or a workspace admin.
// `list` returns what the caller can see (all workspace profiles + their own private ones); the encrypted login blob
// stays server-only, and the interactive session driving capture/restore is always the caller's own. S3 adds cookie
// capture into the profile, S4 geo proxy, S5 injection into evals. Design: docs/architecture/browser-profiles.md.
export interface CreateBrowserProfileInput {
  tenant: string;
  createdBy: string;
  name: string;
  visibility?: BrowserProfileVisibility; // defaults to "private" (personal)
  cookieDomains?: string[];
  country?: string; // the geo (egress-proxy country) the login session ran through — omitted = direct login
}

export interface UpdateBrowserProfileInput {
  name?: string;
  cookieDomains?: string[];
  visibility?: BrowserProfileVisibility; // promote private→workspace ("share") or demote workspace→private
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
      visibility: input.visibility ?? "private", // personal by default — sharing is an explicit opt-in
      cookieDomains: input.cookieDomains ?? [],
      country: input.country ?? null, // null = direct login (no egress proxy)
      capturedAt: null, // no login captured yet — S3 sets it via saveState
      expiresAt: null, // no login captured yet — S3's saveState computes it from the cookies
      createdBy: input.createdBy,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    return record;
  }

  // Profiles the caller can see — every workspace profile + their own private ones.
  list(tenant: string, subject: string): Promise<BrowserProfileRecord[]> {
    return this.deps.store.list(tenant, subject);
  }

  // A single profile the caller can see — a workspace profile is visible to any member; a private one only to its
  // creator. Otherwise 404 (no existence leak — a foreign private profile is indistinguishable from a missing one).
  async get(tenant: string, id: string, subject: string): Promise<BrowserProfileRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record || (record.visibility === "private" && record.createdBy !== subject))
      throw new NotFoundError("NOT_FOUND", { id }, `browser profile '${id}' not found.`);
    return record;
  }

  async update(
    tenant: string,
    id: string,
    patch: UpdateBrowserProfileInput,
    actor: ProfileActor,
  ): Promise<BrowserProfileRecord> {
    await this.manageableOrThrow(tenant, id, actor); // per-visibility gate before the write
    const next: Partial<BrowserProfileRecord> = { updatedAt: this.now() };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.cookieDomains !== undefined) next.cookieDomains = patch.cookieDomains;
    if (patch.visibility !== undefined) next.visibility = patch.visibility;
    const updated = await this.deps.store.update(tenant, id, next);
    if (!updated) throw new NotFoundError("NOT_FOUND", { id }, `browser profile '${id}' not found.`);
    return updated;
  }

  async remove(tenant: string, id: string, actor: ProfileActor): Promise<void> {
    await this.manageableOrThrow(tenant, id, actor);
    await this.deps.store.remove(tenant, id);
  }

  // The gate for every management op (update/remove; the capture service applies the same rule): a `private` profile
  // is manageable ONLY by its creator (invisible to everyone else, so a non-creator gets 404 — no existence leak, no
  // admin override for personal login material); a `workspace` profile is manageable by its creator or a workspace
  // admin (visible, so a non-manager gets 403).
  private async manageableOrThrow(tenant: string, id: string, actor: ProfileActor): Promise<BrowserProfileRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `browser profile '${id}' not found.`);
    if (record.visibility === "private") {
      if (record.createdBy !== actor.subject)
        throw new NotFoundError("NOT_FOUND", { id }, `browser profile '${id}' not found.`);
    } else if (record.createdBy !== actor.subject && !actor.isAdmin) {
      throw new ForbiddenError(
        "FORBIDDEN",
        { id },
        "Only the profile's creator or a workspace admin can manage this shared browser profile.",
      );
    }
    return record;
  }
}

// Who is acting on a profile — the caller's subject + whether they are a workspace admin (creator-override, mirroring
// comments:delete). Reads never need it; writes gate on creator-or-admin.
export interface ProfileActor {
  subject: string;
  isAdmin: boolean;
}
