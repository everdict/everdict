import { type CaseResult, PaymentRequiredError, type TraceEvent } from "@everdict/core";

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

// Sum the trace's llm_call costs → the cost of one run.
export function sumCost(trace: TraceEvent[]): { usd: number; tokens: number } {
  let usd = 0;
  let tokens = 0;
  for (const e of trace) {
    if (e.kind === "llm_call" && e.cost) {
      usd += e.cost.usd;
      tokens += e.cost.inputTokens + e.cost.outputTokens;
    }
  }
  return { usd, tokens };
}

export function costOf(result: CaseResult): { usd: number; tokens: number } {
  return sumCost(result.trace);
}

// Which tenant's budget this run's cost goes on (the settle target tenant) — decided by provenance.
//  - Managed backend (not self-hosted): the job's original tenant pays (originalTenant).
//  - Workspace-shared self-hosted runner (provenance.by = "ws:<workspace>"): that workspace pays (a team resource).
//    by is stamped by SelfHostedBackend as the runner owner, and a workspace-shared runner's owner is "ws:<workspace>".
//  - Personal self-hosted runner (by = subject): the user's own login is the payer → not drawn from the workspace budget (undefined).
// undefined = don't settle (own-pays). Design: docs/architecture/self-hosted-runtime-and-runners.md.
export function billingTenant(result: CaseResult, originalTenant: string): string | undefined {
  const prov = result.provenance;
  if (!prov || prov.ranOn !== "self-hosted") return originalTenant;
  const by = prov.by;
  if (by?.startsWith("ws:")) return by.slice("ws:".length);
  return undefined;
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
      const limit = opts.limitFor(tenant);
      if (!limit) {
        get(tenant).runs += 1; // count runs even when unlimited
        return;
      }
      const u = get(tenant);
      if (limit.usd !== undefined && u.usd >= limit.usd) {
        throw new PaymentRequiredError(
          "BUDGET_EXCEEDED",
          { tenant, usd: u.usd, limit: limit.usd },
          "cost budget exceeded",
        );
      }
      if (limit.tokens !== undefined && u.tokens >= limit.tokens) {
        throw new PaymentRequiredError("BUDGET_EXCEEDED", { tenant, tokens: u.tokens }, "token budget exceeded");
      }
      if (limit.runs !== undefined && u.runs >= limit.runs) {
        throw new PaymentRequiredError(
          "BUDGET_EXCEEDED",
          { tenant, runs: u.runs, limit: limit.runs },
          "run-count budget exceeded",
        );
      }
      u.runs += 1; // reserve (so concurrent bursts can't exceed the cap)
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
