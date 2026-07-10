import { collectAuthEnv } from "@everdict/agent";
import { Metrics } from "@everdict/application-control";
import { type AutoscaleConfig, parseAutoscale, parseTenantMap } from "@everdict/application-control";
import { BackendRegistry, K8sBackend, NomadBackend, Scheduler } from "@everdict/backends";
import type { BudgetStore, SecretStore, UsageStore } from "@everdict/db";
import { Autoscaler, type BudgetLimit, CircuitBreaker, MutableSlots } from "@everdict/domain";
import { persistentBudget } from "../common/budget-tracker.js";
import { persistentUsageMeter } from "../common/usage-meter.js";

// Execution scheduling: the global env backends (Nomad/K8s) + their slot-autoscaling targets + the operator
// fairness dials (quota/weight/queue-depth), feeding the capacity-aware tenant-fair Scheduler.
export function buildExecutionScheduling(deps: {
  nomadAddr: string | undefined;
  k8sContext: string | undefined;
  image: string | undefined;
  secretStore: SecretStore;
}) {
  const { nomadAddr, k8sContext, image, secretStore } = deps;
  // Inject workspace secrets (model/provider keys) only into that tenant's job env (no leakage). The store is always active.
  const secrets = { secretsFor: (tenant: string) => secretStore.entries(tenant) };

  const backends = new BackendRegistry();
  // Slot autoscaling (EVERDICT_AUTOSCALE="min:max[:intervalMs]") — global env backends only: their slot cap
  // becomes a MutableSlots the Autoscaler grows with queue depth (a downstream cluster autoscaler then sees the
  // pending work) and shrinks after idle hysteresis. Tenant runtimes keep their spec-declared envelope.
  const autoscale = parseAutoscale(process.env.EVERDICT_AUTOSCALE);
  const scalingTargets: MutableSlots[] = [];
  const slotsFor = (name: string): MutableSlots | undefined => {
    if (!autoscale) return undefined;
    const slots = new MutableSlots(name, Math.max(1, autoscale.min));
    scalingTargets.push(slots);
    return slots;
  };
  if (nomadAddr && image) {
    const slots = slotsFor("nomad");
    backends.register(
      "nomad",
      new NomadBackend({
        addr: nomadAddr,
        image,
        secretEnv: collectAuthEnv(),
        secrets,
        ...(slots ? { maxConcurrent: slots.get } : {}),
      }),
    );
  } else if (k8sContext && image) {
    const slots = slotsFor("k8s");
    backends.register(
      "k8s",
      new K8sBackend({
        image,
        context: k8sContext,
        secretEnv: collectAuthEnv(),
        secrets,
        ...(slots ? { maxConcurrent: slots.get } : {}),
      }),
    );
  }
  // Policy (default): never register LocalBackend (unisolated in-process on the control-plane host) — every run must
  // target a registered tenant runtime or a self-hosted runner (self:<id>/self:ws). This is the default with no opt-in env.
  // (For dev/single-host in-process runs use apps/cli's `everdict run` — the API only does managed/remote execution.)
  // Operator fairness dials (docs/execution-backends.md): per-tenant concurrent caps + WFQ weights. Unset = the
  // previous defaults (unlimited quota, weight 1) — the fairness machinery is always on; these are just the dials.
  const tenantQuotas = parseTenantMap(process.env.EVERDICT_TENANT_QUOTAS, "EVERDICT_TENANT_QUOTAS");
  const tenantWeights = parseTenantMap(process.env.EVERDICT_TENANT_WEIGHTS, "EVERDICT_TENANT_WEIGHTS");
  const tenantQueueDepths = parseTenantMap(process.env.EVERDICT_TENANT_QUEUE_DEPTHS, "EVERDICT_TENANT_QUEUE_DEPTHS");
  // Runtime-adjustable fairness dials (PUT /internal/scheduling) layered OVER the env defaults — env keeps
  // being the boot baseline, overrides live in memory (a restart falls back to env; documented).
  const quotaOverrides = new Map<string, number>();
  const weightOverrides = new Map<string, number>();
  const schedulingControl = {
    effective(): { quotas: Record<string, number>; weights: Record<string, number> } {
      const tenants = new Set<string>([...quotaOverrides.keys(), ...weightOverrides.keys()]);
      const quotas: Record<string, number> = {};
      const weights: Record<string, number> = {};
      for (const t of tenants) {
        quotas[t] = quotaOverrides.get(t) ?? tenantQuotas?.get(t) ?? Number.POSITIVE_INFINITY;
        weights[t] = weightOverrides.get(t) ?? tenantWeights?.get(t) ?? 1;
      }
      return { quotas, weights };
    },
    set(patch: { quotas?: Record<string, number | null>; weights?: Record<string, number | null> }): void {
      for (const [t, v] of Object.entries(patch.quotas ?? {}))
        v === null ? quotaOverrides.delete(t) : quotaOverrides.set(t, v);
      for (const [t, v] of Object.entries(patch.weights ?? {}))
        v === null ? weightOverrides.delete(t) : weightOverrides.set(t, v);
      scheduler.poke(); // loosened quotas should drain the queue immediately
    },
  };
  const scheduler = new Scheduler(backends, {
    tenantQuota: (t: string) => quotaOverrides.get(t) ?? tenantQuotas?.get(t) ?? Number.POSITIVE_INFINITY,
    weightFor: (t: string) => weightOverrides.get(t) ?? tenantWeights?.get(t) ?? 1,
    ...(tenantQueueDepths
      ? { tenantMaxQueueDepth: (t: string) => tenantQueueDepths.get(t) ?? Number.POSITIVE_INFINITY }
      : {}),
  });
  return { backends, scheduler, schedulingControl, autoscale, scalingTargets, tenantQuotas };
}

// Prometheus metrics (docs/architecture/work-queue.md — the time-series half; /queue is the snapshot half)
// + the per-runtime circuit breaker + the scrape-time scheduler gauges.
export function buildObservability(scheduler: Scheduler) {
  const metrics = new Metrics();
  // Per-runtime circuit breaker — shared between the batch spillover (ScorecardService) and the queue view
  // (observability): one health memory, three consumers (spillover · queue view · metrics).
  const breaker = new CircuitBreaker({
    onOpen: (key) =>
      metrics.counter("everdict_breaker_open_total", "Circuit-breaker open transitions.", { circuit: key }),
  });
  // Scrape-time gauges — sampled live so the scrape always reflects the current scheduler state.
  metrics.gauge("everdict_scheduler_queued", "Jobs waiting in the control-plane scheduler queue.", () => [
    { labels: {}, value: scheduler.stats().queued },
  ]);
  metrics.gauge("everdict_scheduler_inflight", "In-flight dispatches per backend.", () =>
    Object.entries(scheduler.stats().inFlight).map(([backend, value]) => ({ labels: { backend }, value })),
  );
  metrics.gauge("everdict_scheduler_mem_inflight_mb", "In-flight harness-declared memory per backend (Mb).", () =>
    Object.entries(scheduler.stats().memInFlightMb).map(([backend, value]) => ({ labels: { backend }, value })),
  );
  metrics.gauge("everdict_scheduler_cpu_inflight", "In-flight harness-declared cpu per backend (1000 = 1 vCPU).", () =>
    Object.entries(scheduler.stats().cpuInFlight).map(([backend, value]) => ({ labels: { backend }, value })),
  );
  metrics.gauge("everdict_tenant_inflight", "In-flight dispatches per workspace.", () =>
    Object.entries(scheduler.stats().tenantInFlight).map(([tenant, value]) => ({ labels: { tenant }, value })),
  );
  metrics.gauge("everdict_tenant_queued", "Queued jobs per workspace.", () =>
    Object.entries(scheduler.stats().queuedByTenant).map(([tenant, value]) => ({ labels: { tenant }, value })),
  );
  metrics.gauge("everdict_breaker_open", "Currently-open circuits (1 = open).", () =>
    Object.entries(breaker.stats())
      .filter(([, st]) => st.open)
      .map(([circuit]) => ({ labels: { circuit }, value: 1 })),
  );
  return { metrics, breaker };
}

// Slot autoscaler (EVERDICT_AUTOSCALE) — grows the global backends' slots with queue depth, shrinks after idle.
export function startAutoscaler(deps: {
  autoscale: AutoscaleConfig | undefined;
  scalingTargets: MutableSlots[];
  scheduler: Scheduler;
}): void {
  const { autoscale, scalingTargets, scheduler } = deps;
  if (autoscale && scalingTargets.length > 0) {
    const autoscaler = new Autoscaler({
      // Demand = this deployment's whole backlog + what the global backends already run (tenant-runtime jobs
      // never target these slots, but their queue share still signals pressure — clamped by max anyway).
      signal: () => {
        const s = scheduler.stats();
        const inFlight = scalingTargets.reduce((a, t) => a + (s.inFlight[t.id] ?? 0), 0);
        return { queued: s.queued, inFlight };
      },
      targets: scalingTargets,
      policy: { min: autoscale.min, max: autoscale.max },
      ...(autoscale.intervalMs !== undefined ? { intervalMs: autoscale.intervalMs } : {}),
      onScale: (id, from, to) => console.log(`▶ autoscale ${id}: ${from} → ${to} slots`),
      onChanged: () => scheduler.poke(), // re-pump so newly-granted slots drain the queue immediately
    });
    autoscaler.start();
    console.log(
      `▶ autoscale: [${scalingTargets.map((t) => t.id).join(", ")}] slots ${autoscale.min}..${autoscale.max}`,
    );
  }
}

// Budgets: the enforcement budget (402-blocking) + the meter-only usage accounting — both hydrate from their
// durable stores at boot so caps and usage survive restarts.
export async function buildBudgets(deps: { budgetStore: BudgetStore; usageStore: UsageStore }) {
  const { budgetStore, usageStore } = deps;
  // Enforcement budget (blocks with 402; distinct from the meter-only usage above). In-memory decision + best-effort
  // write-through to the durable BudgetStore + boot hydration → caps + usage survive restarts. DB-set per-tenant
  // limits take precedence; env-configured limits (budgetFromEnv) are the fallback for tenants without a stored one.
  const budget = persistentBudget(budgetStore, { fallback: budgetFromEnv() });
  await budget.hydrate();
  // Meter-only usage accounting for billing (never blocks; distinct from the enforcement budget above). Read via GET /usage.
  // In-memory reads + best-effort write-through to the durable UsageStore + boot hydration → usage survives restarts.
  const usageMeter = persistentUsageMeter(usageStore);
  await usageMeter.hydrate();
  return { budget, usageMeter };
}

function budgetFromEnv(): (tenant: string) => BudgetLimit | undefined {
  const runs = process.env.EVERDICT_TENANT_RUNS ? Number(process.env.EVERDICT_TENANT_RUNS) : undefined;
  const usd = process.env.EVERDICT_TENANT_USD ? Number(process.env.EVERDICT_TENANT_USD) : undefined;
  if (runs === undefined && usd === undefined) return () => undefined;
  const limit: BudgetLimit = { ...(runs !== undefined ? { runs } : {}), ...(usd !== undefined ? { usd } : {}) };
  return () => limit;
}
