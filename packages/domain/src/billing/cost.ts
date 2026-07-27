import type { CaseResult, TraceEvent, UsageCost, UsageSource } from "@everdict/contracts";

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

// Split a trace's llm_call cost by model string → { model → cost }. The carrier for per-model itemization.
function costByModel(trace: TraceEvent[]): Map<string, UsageCost> {
  const byModel = new Map<string, UsageCost>();
  for (const e of trace) {
    if (e.kind === "llm_call" && e.cost) {
      const m = byModel.get(e.model) ?? { usd: 0, tokens: 0 };
      m.usd += e.cost.usd;
      m.tokens += e.cost.inputTokens + e.cost.outputTokens;
      byModel.set(e.model, m);
    }
  }
  return byModel;
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

// One (tenant, source, model) billing line for a completed case — the unit both the meter and the enforcement budget
// commit. evaluations is 1 on exactly one charge per case (one case = one metered evaluation), 0 on the rest.
export interface BillingCharge {
  tenant: string;
  source: UsageSource;
  model: string;
  cost: UsageCost;
  evaluations: number;
}

// Attribute a completed case's LLM cost to billing lines, itemized per model.
//  - Managed / workspace-shared runner (billingTenant defined): the WHOLE cost bills to that tenant, split per model.
//  - Personal self-hosted (own-pays, billingTenant undefined): only calls to a WORKSPACE-BILLED model
//    (provenance.billedModels — the model's key came from the workspace secret tier) bill to the workspace; calls on
//    the user's own login stay own-pays (not billed). This is what lets a BYO-compute run still charge the workspace
//    for the tokens the workspace actually paid for. docs/architecture/usage-metering.md
export function billingCharges(result: CaseResult, originalTenant: string): BillingCharge[] {
  const base = billingTenant(result, originalTenant);
  const billed = new Set((result.provenance?.billedModels ?? []).map((b) => b.model));
  const charges: BillingCharge[] = [];
  for (const [model, cost] of costByModel(result.trace)) {
    const tenant = base !== undefined ? base : billed.has(model) ? originalTenant : undefined;
    if (tenant === undefined) continue; // own-pays call on the user's own login — not billed
    charges.push({ tenant, source: "harness", model, cost, evaluations: 0 });
  }
  // One case = one metered evaluation. Attribute it to the first billable line; if the case is billable but produced
  // no per-model cost (empty/$0 trace on a managed run), still count the evaluation with an empty-model line.
  const first = charges[0];
  if (first) first.evaluations = 1;
  else if (base !== undefined)
    charges.push({ tenant: base, source: "harness", model: "", cost: { usd: 0, tokens: 0 }, evaluations: 1 });
  return charges;
}
