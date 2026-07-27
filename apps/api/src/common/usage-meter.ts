import type { UsageStore } from "@everdict/db";
import { type UsageMeter, inMemoryUsageMeter } from "@everdict/domain";

// A persistent usage meter: in-memory for fast synchronous reads (GET /usage) with a best-effort WRITE-THROUGH to a
// durable UsageStore, and boot HYDRATION so metered usage survives a restart. Single-process read model (the in-memory
// accumulator is the runtime source of truth — same assumption as BudgetTracker). A failed persist never blocks or
// fails metering (meter-only). docs/architecture/usage-metering.md
export function persistentUsageMeter(store: UsageStore): UsageMeter & { hydrate(): Promise<void> } {
  const mem = inMemoryUsageMeter();
  const meter: UsageMeter = {
    record(tenant, source, model, cost, evaluations = 0) {
      mem.record(tenant, source, model, cost, evaluations);
      void store.record(tenant, source, model, cost, evaluations).catch(() => {}); // best-effort persist — never blocks
    },
    usage: (tenant) => mem.usage(tenant),
  };
  return {
    ...meter,
    // Load every accumulated row back into the in-memory meter at boot, so usage survives a control-plane restart.
    async hydrate() {
      for (const row of await store.all()) {
        mem.record(row.tenant, row.source, row.model, { usd: row.usd, tokens: row.tokens }, row.evaluations);
      }
    },
  };
}
