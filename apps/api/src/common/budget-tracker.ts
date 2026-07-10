import type { BudgetStore } from "@everdict/db";
import { type BudgetLimit, type BudgetTracker, type BudgetUsage, assertWithinBudget } from "@everdict/domain";
import { z } from "zod";

// A per-tenant limit as set over the API (each dimension optional; an omitted dimension = unlimited). A PUT replaces
// the whole limit. Shared by the HTTP route and the MCP tool (one validation, two transports).
export const BudgetLimitInputSchema = z.object({
  usd: z.number().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
  runs: z.number().int().nonnegative().optional(),
});

// The read/config surface the budget API needs — a narrow view of PersistentBudget so server.ts/mcp.ts don't take
// the whole tracker (they never admit/settle; that's the Scheduler's job).
export interface BudgetAdmin {
  usage(tenant: string): BudgetUsage;
  limitOf(tenant: string): BudgetLimit | undefined;
  setLimit(tenant: string, limit: BudgetLimit): Promise<void>;
}

// The persistent, per-tenant budget tracker mirrors persistentUsageMeter: the in-memory maps are the runtime source
// of truth (admit enforces synchronously) with best-effort WRITE-THROUGH to a durable BudgetStore and boot HYDRATION,
// so caps + usage survive a control-plane restart. Limits are DB-backed (set via the API); an optional `fallback`
// supplies env-configured caps for tenants without a stored limit (bootstrap / backward compat). A failed persist
// never blocks admission (the in-memory decision already stands). Single-process read model.
export interface PersistentBudget extends BudgetTracker {
  hydrate(): Promise<void>;
  setLimit(tenant: string, limit: BudgetLimit): Promise<void>;
  limitOf(tenant: string): BudgetLimit | undefined;
}

export function persistentBudget(
  store: BudgetStore,
  opts: { fallback?: (tenant: string) => BudgetLimit | undefined } = {},
): PersistentBudget {
  const usage = new Map<string, BudgetUsage>();
  const limits = new Map<string, BudgetLimit>();
  const get = (t: string): BudgetUsage => {
    let u = usage.get(t);
    if (!u) {
      u = { usd: 0, tokens: 0, runs: 0 };
      usage.set(t, u);
    }
    return u;
  };
  const limitFor = (t: string): BudgetLimit | undefined => limits.get(t) ?? opts.fallback?.(t);
  return {
    admit(tenant) {
      assertWithinBudget(tenant, get(tenant), limitFor(tenant)); // throws 402 before we reserve
      get(tenant).runs += 1;
      void store.addUsage(tenant, { runs: 1 }).catch(() => {}); // best-effort persist — never blocks admission
    },
    release(tenant) {
      const u = get(tenant);
      u.runs = Math.max(0, u.runs - 1);
      void store.addUsage(tenant, { runs: -1 }).catch(() => {});
    },
    settle(tenant, cost) {
      const u = get(tenant);
      u.usd += cost.usd;
      u.tokens += cost.tokens;
      void store.addUsage(tenant, { usd: cost.usd, tokens: cost.tokens }).catch(() => {});
    },
    usage: (tenant) => ({ ...get(tenant) }),
    limitOf: (tenant) => limitFor(tenant),
    async setLimit(tenant, limit) {
      limits.set(tenant, limit);
      await store.setLimit(tenant, limit);
    },
    // Load durable usage + limits into memory at boot so caps and counters survive a restart.
    async hydrate() {
      for (const r of await store.allUsage()) usage.set(r.tenant, { usd: r.usd, tokens: r.tokens, runs: r.runs });
      for (const l of await store.allLimits()) {
        limits.set(l.tenant, {
          ...(l.usd !== undefined ? { usd: l.usd } : {}),
          ...(l.tokens !== undefined ? { tokens: l.tokens } : {}),
          ...(l.runs !== undefined ? { runs: l.runs } : {}),
        });
      }
    },
  };
}
