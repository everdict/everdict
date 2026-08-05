import type { PlatformEventDailyCount, PlatformEventRecord } from "@everdict/contracts";

export interface PlatformEventListOptions {
  afterSeq?: number; // only events with seq > afterSeq (the reconcile cursor)
  kinds?: string[]; // restrict to these kinds
  limit?: number; // default 100
  // "asc" (default) walks the reconcile cursor; "desc" serves the newest-first surfaces (fleet feed, replay picker).
  order?: "asc" | "desc";
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
  // The log COUNTED rather than read — one (day × kind × outcome) bucket per group, for the workspace pulse's
  // trend (docs/architecture/workspace-pulse.md). A month of history is a few dozen integers here; served by
  // `list` it would be thousands of rows the caller decodes only to tally. `from` is inclusive, `to` exclusive,
  // both ISO instants; days are UTC, matching the usage series.
  dailyCounts(tenant: string, range: { from: string; to: string }): Promise<PlatformEventDailyCount[]>;
  // EO4 retention: prune facts older than the cutoff (TTL must exceed max consumer lag + the replay window —
  // the operator's knob, not a default). Run provenance survives pruning (origin embeds kind/subject), and
  // cursors are seq-based, so a pruned prefix just stops being replayable. Returns rows removed.
  deleteOlderThan(cutoffIso: string): Promise<number>;
}
