import type { CaseResult } from "@everdict/core";
import { billingTenant, costOf } from "./cost.js";

// Usage metering for billing — the pricing surface. Meter-only: it NEVER blocks (distinct from the enforcement
// BudgetTracker, whose admit() throws 402). The billable surface is orchestration + verdict LLM cost — the harness
// under test and the eval/judge model — NOT resold compute (compute is BYO / own-pays). So a personal self-hosted
// (own-pays) run's harness cost is not metered here (the tenant paid their own login directly); a managed or
// workspace-shared run is. docs/architecture/one-call-sdk.md

// Where a metered LLM cost came from: the harness under test, or the eval/judge model.
export type UsageSource = "harness" | "judge";
const SOURCES: readonly UsageSource[] = ["harness", "judge"];

export interface UsageTotals {
  usd: number;
  tokens: number;
  evaluations: number; // metered case-evaluations (cases × trials that ran and were billable)
}

export interface TenantUsage extends UsageTotals {
  bySource: Record<UsageSource, UsageTotals>;
}

export interface UsageMeter {
  // Record LLM cost against a tenant + source. evaluations defaults to 0 (a judge score adds cost, not an evaluation).
  record(tenant: string, source: UsageSource, cost: { usd: number; tokens: number }, evaluations?: number): void;
  // Meter a completed case's harness LLM cost, attributed to the billing tenant (own-pays self-hosted → not metered).
  meterCase(result: CaseResult, originalTenant: string): void;
  usage(tenant: string): TenantUsage;
}

function emptyTotals(): UsageTotals {
  return { usd: 0, tokens: 0, evaluations: 0 };
}

// In-memory usage meter (dev/test / a single control-plane process). Persisting usage for real billing is a follow-up.
export function inMemoryUsageMeter(): UsageMeter {
  const byTenant = new Map<string, TenantUsage>();
  const get = (tenant: string): TenantUsage => {
    let u = byTenant.get(tenant);
    if (!u) {
      u = { ...emptyTotals(), bySource: { harness: emptyTotals(), judge: emptyTotals() } };
      byTenant.set(tenant, u);
    }
    return u;
  };
  return {
    record(tenant, source, cost, evaluations = 0) {
      const u = get(tenant);
      u.usd += cost.usd;
      u.tokens += cost.tokens;
      u.evaluations += evaluations;
      const s = u.bySource[source];
      s.usd += cost.usd;
      s.tokens += cost.tokens;
      s.evaluations += evaluations;
    },
    meterCase(result, originalTenant) {
      const tenant = billingTenant(result, originalTenant); // undefined = own-pays → not metered (BYO compute)
      if (!tenant) return;
      this.record(tenant, "harness", costOf(result), 1);
    },
    usage(tenant) {
      const u = get(tenant);
      return {
        usd: u.usd,
        tokens: u.tokens,
        evaluations: u.evaluations,
        bySource: {
          harness: { ...u.bySource.harness },
          judge: { ...u.bySource.judge },
        },
      };
    },
  };
}

// Total metered usage across the given tenants (for an operator/rollup view).
export function totalUsage(meter: UsageMeter, tenants: string[]): UsageTotals {
  const total = emptyTotals();
  for (const tenant of tenants) {
    const u = meter.usage(tenant);
    total.usd += u.usd;
    total.tokens += u.tokens;
    total.evaluations += u.evaluations;
  }
  return total;
}

export { SOURCES as USAGE_SOURCES };
