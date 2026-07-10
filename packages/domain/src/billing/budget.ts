import { PaymentRequiredError } from "@everdict/contracts";

// Enforcement budget — the blocking half of the billing domain (admit() throws 402; distinct from meter-only usage).

// Tenant budget. Any dimension left unset is unlimited.
export interface BudgetLimit {
  usd?: number; // cumulative cost cap
  tokens?: number; // cumulative token cap
  runs?: number; // cumulative run-count cap (rate/volume)
}

export interface BudgetUsage {
  usd: number;
  tokens: number;
  runs: number; // number of admitted runs (incl. reservations)
}

// Tenant budget tracker.
//  - admit: checked before accepting a run (before queuing). If already-committed usd/tokens are at the cap, or runs
//    (incl. reservations) is at the cap, PaymentRequiredError (402). If it passes, immediately reserve one run (so a burst can't exceed the cap).
//  - settle: commit the actual cost (usd/tokens) after the run completes. (usd/tokens aren't known before execution,
//    so the last run that slightly exceeds the cap is allowed — the standard behavior of a cost budget.)
export interface BudgetTracker {
  admit(tenant: string): void;
  // Undo an admit reservation for a job that was admitted but then left WITHOUT running (cancelled while queued,
  // superseded, or an immediate placement failure). Decrements the reserved run count so a never-run job doesn't
  // permanently inflate the tenant's budget. Never touches usd/tokens (those are settled only on real completion).
  release(tenant: string): void;
  settle(tenant: string, cost: { usd: number; tokens: number }): void;
  usage(tenant: string): BudgetUsage;
}

export interface InMemoryBudgetOptions {
  limitFor: (tenant: string) => BudgetLimit | undefined;
}

// The admission check shared by every BudgetTracker impl (in-memory + the persistent one in apps/api): throw a 402 if
// any already-committed dimension is at/above its cap. usd/tokens aren't known before a run, so the last run that
// slightly exceeds is allowed — the standard cost-budget behavior. Call BEFORE reserving the run.
export function assertWithinBudget(tenant: string, usage: BudgetUsage, limit: BudgetLimit | undefined): void {
  if (!limit) return;
  if (limit.usd !== undefined && usage.usd >= limit.usd)
    throw new PaymentRequiredError(
      "BUDGET_EXCEEDED",
      { tenant, usd: usage.usd, limit: limit.usd },
      "cost budget exceeded",
    );
  if (limit.tokens !== undefined && usage.tokens >= limit.tokens)
    throw new PaymentRequiredError("BUDGET_EXCEEDED", { tenant, tokens: usage.tokens }, "token budget exceeded");
  if (limit.runs !== undefined && usage.runs >= limit.runs)
    throw new PaymentRequiredError(
      "BUDGET_EXCEEDED",
      { tenant, runs: usage.runs, limit: limit.runs },
      "run-count budget exceeded",
    );
}

export function inMemoryBudget(opts: InMemoryBudgetOptions): BudgetTracker {
  const usage = new Map<string, BudgetUsage>();
  const get = (t: string): BudgetUsage => {
    let u = usage.get(t);
    if (!u) {
      u = { usd: 0, tokens: 0, runs: 0 };
      usage.set(t, u);
    }
    return u;
  };
  return {
    admit(tenant) {
      assertWithinBudget(tenant, get(tenant), opts.limitFor(tenant));
      get(tenant).runs += 1; // reserve (so concurrent bursts can't exceed the cap; counted even when unlimited)
    },
    release(tenant) {
      const u = get(tenant);
      u.runs = Math.max(0, u.runs - 1); // give back the reserved run; floor at 0 so releases can't underflow
    },
    settle(tenant, cost) {
      const u = get(tenant);
      u.usd += cost.usd;
      u.tokens += cost.tokens;
    },
    usage(tenant) {
      return { ...get(tenant) };
    },
  };
}
