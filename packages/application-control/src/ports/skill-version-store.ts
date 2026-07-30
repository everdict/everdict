import type { SkillVersionRecord } from "@everdict/contracts";

// A skill's version line — the immutable snapshots its authors decided to name. Kept OUT of SkillStore on purpose:
// the skill row is the working copy (read on every agent turn), the line is history (read only when someone opens the
// version panel), and the split mirrors WorkspaceFs ← FsRevisionStore.
//
// `stamp` must be atomic on (tenant, skillId, version): a version already on the line is NEVER rewritten — that
// immutability is what lets "what did this procedure say when we ran that eval?" have an answer. Implementations:
// InMemorySkillVersionStore / PgSkillVersionStore in @everdict/db.
export interface SkillVersionStore {
  // Freeze one version. Throws ConflictError when (tenant, skillId, version) is already stamped.
  stamp(record: SkillVersionRecord): Promise<void>;
  // The skill's stamped versions, newest first.
  list(tenant: string, skillId: string): Promise<SkillVersionRecord[]>;
  get(tenant: string, skillId: string, version: string): Promise<SkillVersionRecord | undefined>;
  // Drop a skill's whole line — called when the skill itself is deleted (history of a gone skill is a leak, and the
  // id could be reused).
  remove(tenant: string, skillId: string): Promise<void>;
}
