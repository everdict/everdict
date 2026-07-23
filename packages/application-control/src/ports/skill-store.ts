import type { SkillRecord } from "@everdict/contracts";

// Persistence port for workspace Skills — SKILL.md-style procedures the members author. Dual-scoped like browser
// profiles / Views: a skill is either `private` (personal draft, creator-only) or `workspace` (a shared asset).
// `list` returns what a caller can see — every workspace skill in the tenant plus the caller's own private ones
// (mirrors BrowserProfileStore.list / ViewStore.listVisible); the per-visibility manage gate lives in the service.
// Impls: InMemory / Pg in @everdict/db.
export interface SkillStore {
  create(record: SkillRecord): Promise<void>;
  get(tenant: string, id: string): Promise<SkillRecord | undefined>;
  list(tenant: string, subject: string): Promise<SkillRecord[]>;
  update(tenant: string, id: string, patch: Partial<SkillRecord>): Promise<SkillRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}
