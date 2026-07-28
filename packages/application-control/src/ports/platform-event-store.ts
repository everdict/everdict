import type { PlatformEventRecord } from "@everdict/contracts";

export interface PlatformEventListOptions {
  afterSeq?: number; // only events with seq > afterSeq (the reconcile cursor)
  kinds?: string[]; // restrict to these kinds
  limit?: number; // default 100
}

// Append-only platform event log (docs/architecture/agent-automation.md A1) — the durable record behind
// emitPlatformEvent. `append` assigns the monotonic seq; `list` reads ascending by seq so a consumer can
// walk the cursor. Impls: InMemoryPlatformEventStore / PgPlatformEventStore (@everdict/db).
export interface PlatformEventStore {
  append(record: Omit<PlatformEventRecord, "seq">): Promise<PlatformEventRecord>;
  list(tenant: string, opts?: PlatformEventListOptions): Promise<PlatformEventRecord[]>;
  // Cross-tenant cursor walk — the agent service's ONE global reconcile loop (it can't know which workspaces
  // have enabled agents without reading every registry, so it walks one deployment-wide cursor instead).
  listAll(opts?: PlatformEventListOptions): Promise<PlatformEventRecord[]>;
  get(tenant: string, id: string): Promise<PlatformEventRecord | undefined>;
}
