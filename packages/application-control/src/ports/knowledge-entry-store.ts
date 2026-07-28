import type { KnowledgeEntryRecord } from "@everdict/contracts";

// Persistence port for knowledge entries — reified claims (the knowledge layer's record, the promoted successor of an
// `annotate` note). Dual-scoped like Skills / browser profiles: `private` = a personal draft (creator-only),
// `workspace` = shared workspace knowledge. `list` returns what a caller can see (workspace entries + their own
// private ones); the per-visibility manage gate lives in the service. Impls: InMemory / Pg in @everdict/db.
export interface KnowledgeEntryStore {
  create(record: KnowledgeEntryRecord): Promise<void>;
  get(tenant: string, id: string): Promise<KnowledgeEntryRecord | undefined>;
  list(tenant: string, subject: string): Promise<KnowledgeEntryRecord[]>;
  update(tenant: string, id: string, patch: Partial<KnowledgeEntryRecord>): Promise<KnowledgeEntryRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}
