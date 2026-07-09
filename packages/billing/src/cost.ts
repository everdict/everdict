import type { CaseResult, TraceEvent } from "@everdict/core";

// Cost attribution — the shared vocabulary of the billing domain (enforcement budget + metered usage both use it).

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

// Which tenant's cost this run goes on (the settle/meter target tenant) — decided by provenance.
//  - Managed backend (not self-hosted): the job's original tenant pays (originalTenant).
//  - Workspace-shared self-hosted runner (provenance.by = "ws:<workspace>"): that workspace pays (a team resource).
//    by is stamped by SelfHostedBackend as the runner owner, and a workspace-shared runner's owner is "ws:<workspace>".
//  - Personal self-hosted runner (by = subject): the user's own login is the payer → not drawn from the workspace budget (undefined).
// undefined = don't settle/meter (own-pays). Design: docs/architecture/self-hosted-runtime-and-runners.md.
export function billingTenant(result: CaseResult, originalTenant: string): string | undefined {
  const prov = result.provenance;
  if (!prov || prov.ranOn !== "self-hosted") return originalTenant;
  const by = prov.by;
  if (by?.startsWith("ws:")) return by.slice("ws:".length);
  return undefined;
}
