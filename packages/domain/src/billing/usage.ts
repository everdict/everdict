import { USAGE_LEGACY_DAY, type UsageCost, type UsageSource } from "@everdict/contracts";

// Usage metering for billing — the pricing surface. Meter-only: it NEVER blocks (distinct from the enforcement
// BudgetTracker, whose admit() throws 402). The billable surface is orchestration + verdict LLM cost — the harness
// under test, the eval/judge model, and agent conversations — NOT resold compute (compute is BYO / own-pays). A
// completed case is attributed to billing lines by `billingCharges` (@everdict/domain billing/cost) — a personal
// self-hosted (own-pays) run's cost is not metered UNLESS it used a workspace-billed model (its key came from the
// workspace secret tier). The meter just records those lines; usage is itemized per (source × model) so a workspace
// sees which model each activity spent on. docs/architecture/usage-metering.md

// UsageSource is the SSOT in @everdict/contracts — re-export it so `@everdict/domain` consumers keep their import.
export type { UsageSource } from "@everdict/contracts";

export interface UsageTotals {
  usd: number;
  tokens: number;
  evaluations: number; // metered case-evaluations (cases × trials that ran and were billable)
}

// One (source × model) line of the itemized breakdown.
export interface UsageItem extends UsageTotals {
  source: UsageSource;
  model: string;
}

// One (day × source × model) line of the daily spend series — what the billing chart plots.
export interface UsageDayItem extends UsageItem {
  day: string; // UTC day, YYYY-MM-DD
}

export interface TenantUsage extends UsageTotals {
  bySource: Record<UsageSource, UsageTotals>;
  items: UsageItem[];
  daily: UsageDayItem[]; // oldest day first; the pre-itemization legacy bucket is excluded
}

// The UTC day a cost lands on. Callers that need determinism pass the day explicitly instead.
export function usageDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export interface UsageMeter {
  // Record LLM cost against a tenant + source + model. evaluations defaults to 0 (a judge score adds cost, not an
  // evaluation); day defaults to today (UTC). The caller supplies the billing lines (billingCharges); the meter
  // just accumulates them.
  record(tenant: string, source: UsageSource, model: string, cost: UsageCost, evaluations?: number, day?: string): void;
  usage(tenant: string): TenantUsage;
}

function emptyTotals(): UsageTotals {
  return { usd: 0, tokens: 0, evaluations: 0 };
}

function emptyBySource(): Record<UsageSource, UsageTotals> {
  return { harness: emptyTotals(), judge: emptyTotals(), agent: emptyTotals() };
}

interface TenantAcc {
  totals: UsageTotals;
  bySource: Record<UsageSource, UsageTotals>;
  byItem: Map<string, UsageItem>; // key = `${source} ${model}`
  byDay: Map<string, UsageDayItem>; // key = `${day} ${source} ${model}`
}

function add(t: UsageTotals, cost: UsageCost, evaluations: number): void {
  t.usd += cost.usd;
  t.tokens += cost.tokens;
  t.evaluations += evaluations;
}

// In-memory usage meter (dev/test / a single control-plane process). Durability = a write-through wrapper (apps/api).
export function inMemoryUsageMeter(): UsageMeter {
  const byTenant = new Map<string, TenantAcc>();
  const get = (tenant: string): TenantAcc => {
    let u = byTenant.get(tenant);
    if (!u) {
      u = { totals: emptyTotals(), bySource: emptyBySource(), byItem: new Map(), byDay: new Map() };
      byTenant.set(tenant, u);
    }
    return u;
  };
  const meter: UsageMeter = {
    record(tenant, source, model, cost, evaluations = 0, day = usageDay()) {
      const u = get(tenant);
      add(u.totals, cost, evaluations);
      add(u.bySource[source], cost, evaluations);
      const key = `${source} ${model}`;
      let item = u.byItem.get(key);
      if (!item) {
        item = { source, model, ...emptyTotals() };
        u.byItem.set(key, item);
      }
      add(item, cost, evaluations);
      const dayKey = [day, key].join(" ");
      let dayItem = u.byDay.get(dayKey);
      if (!dayItem) {
        dayItem = { day, source, model, ...emptyTotals() };
        u.byDay.set(dayKey, dayItem);
      }
      add(dayItem, cost, evaluations);
    },
    usage(tenant) {
      const u = get(tenant);
      return {
        ...u.totals,
        bySource: {
          harness: { ...u.bySource.harness },
          judge: { ...u.bySource.judge },
          agent: { ...u.bySource.agent },
        },
        items: [...u.byItem.values()].map((i) => ({ ...i })),
        // The legacy bucket predates daily itemization — real in the totals, meaningless on a date axis.
        daily: [...u.byDay.values()]
          .filter((d) => d.day !== USAGE_LEGACY_DAY)
          .sort(
            (a, b) => a.day.localeCompare(b.day) || a.source.localeCompare(b.source) || a.model.localeCompare(b.model),
          )
          .map((d) => ({ ...d })),
      };
    },
  };
  return meter;
}
