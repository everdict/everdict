import { NotFoundError, type RunStatus, type ScorecardStatus, TRACE_EVAL_REF } from "@everdict/contracts";
import type { RunStore } from "../ports/run-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import type { ScheduleRecordWithNext } from "../schedule/schedule-service.js";

// Work queue snapshot — "what is running/waiting where (which runtime) right now, and what's next" on one screen.
// The unit is batch=1 item (a scorecard, with progress) + standalone run=1 item (child runs are folded into the batch's progress — a design decision).
// Lane = runtime: '' = default backend, 'self:<runnerId>' = self-hosted runner, otherwise = a registered runtime id.
// Design: docs/architecture/work-queue.md.

export interface QueueItem {
  type: "scorecard" | "run";
  id: string;
  status: "queued" | "running";
  dataset?: { id: string; version: string }; // scorecards only
  harness: { id: string; version: string };
  caseId?: string; // standalone runs only
  trigger?: string; // where it was fired from (web|api|schedule|scorecard…) — trigger for a run, origin.source for a scorecard
  createdBy?: string; // the runner subject (if any)
  createdAt: string;
  // Batch progress (running scorecards only) — done=finished (succeeded+failed) children, active=running children
  // (a runner is actually executing them), waiting=queued children (parked, waiting for a runner/backend slot),
  // total=number of dataset cases (omitted if resolution fails → the UI shows only done/active/waiting).
  progress?: { done: number; active: number; waiting: number; total?: number };
}

export interface QueueUpcoming {
  scheduleId: string;
  name: string;
  at: string; // next fire time (ISO, Temporal authoritative) — omit the entry itself if absent
  dataset: string;
  harness: string;
}

// Scheduler-level admission view of a lane — what the control plane is actually letting through right now.
// This is the observability half of the fairness/envelope machinery (docs/execution-backends.md): without it the
// operator turns the quota/envelope dials blind.
export interface QueueLaneAdmission {
  inFlight: number; // scheduler-tracked dispatches currently on this lane's backend(s)
  memInFlightMb?: number; // sum of in-flight harness-declared memory (resource-aware admission)
  memoryBudgetMb?: number; // the runtime's declared memory envelope (RuntimeSpec)
  cpuInFlight?: number; // sum of in-flight harness-declared cpu (resources.cpu units, 1000 = 1 vCPU)
  cpuBudget?: number; // the runtime's declared cpu envelope (RuntimeSpec)
  maxConcurrent?: number; // the runtime's declared slot cap (RuntimeSpec)
  circuit?: { open: boolean; consecutive: number }; // spillover breaker state (open = dispatches skip this runtime)
}

export interface QueueLane {
  runtime: string; // '' = default backend
  label?: string; // human-readable label (personal lane = runner hostname). If absent, show runtime as-is.
  registered: boolean; // whether the lane is registered in the runtime registry (to distinguish default/self/deleted)
  admission?: QueueLaneAdmission; // scheduler admission view (absent for self-hosted lanes — those are lease queues)
  running: QueueItem[]; // running — oldest first
  queued: QueueItem[]; // waiting — FIFO (the front is the next item)
  upcoming: QueueUpcoming[]; // next fires of active schedules aimed at this lane (soonest first)
}

// One waiting entry of the control-plane scheduler's OWN queue (the WFQ its pump drains) — the real control
// queue, not the record-status projection the lanes are built from. Tenant-scoped: the service filters before
// anything leaves the control plane; position is 1-based among THIS workspace's entries in effective scan order.
export interface QueueSchedulerEntry {
  id: string; // stable entry handle — what cancel/promote address
  caseId: string;
  runId?: string; // trace-correlation run id (evd-…) when the dispatch minted one
  batchId?: string; // parent scorecard for batch fan-out entries
  harness: { id: string; version: string };
  target?: string; // pinned placement target (the runtime lane it waits for)
  priority?: "interactive" | "batch";
  tags?: string[]; // evalCase tags — e.g. ["judge"] marks a control-plane judge job
  enqueuedAt: string; // ISO
  waitedMs: number;
  position: number;
  urgent: boolean; // scanned in the urgent class (interactive / promoted / aged)
  promoted: boolean;
}

// The queue has two scopes (distinct queues): ① workspace — items requested in the workspace and running on shared runtimes (default backend +
// registered infra). ② personal — the requester's "own" self-hosted runner (self:<id>) queue.
// Another member's personal runner queue is invisible since it's personally owned (same as the runner ownership model).
export interface QueueSnapshot {
  generatedAt: string;
  totals: { running: number; queued: number; upcoming: number }; // sum of visible (workspace+personal) items
  // THIS workspace's scheduler slice (never another tenant's numbers): jobs waiting in the control-plane
  // scheduler queue + in-flight, the operator quota when one is dialed in (EVERDICT_TENANT_QUOTAS), and the
  // workspace's waiting entries in the scheduler's effective scan order (when the live Scheduler is injected).
  scheduler?: { queued: number; inFlight: number; quota?: number; entries?: QueueSchedulerEntry[] };
  workspace: QueueLane[];
  personal: QueueLane[];
}

// The raw scheduler-entry shape the live Scheduler reports (epoch clock, tenant still attached) — the service
// maps it to the tenant-scoped QueueSchedulerEntry. Structural (application-control must not import backends).
export interface SchedulerQueueEntryView {
  id: string;
  tenant: string;
  caseId: string;
  runId?: string;
  batchId?: string;
  harness: { id: string; version: string };
  target?: string;
  priority?: "interactive" | "batch";
  tags?: string[];
  enqueuedAt: number; // epoch ms
  urgent: boolean;
  promoted: boolean;
}

export interface QueueServiceDeps {
  scorecards: ScorecardStore;
  runs?: RunStore; // standalone run items + batch progress (child counts). If unset, scorecards only.
  schedules?: { list(tenant: string): Promise<ScheduleRecordWithNext[]> }; // next fires (upcoming)
  runtimes?: { list(tenant: string): Promise<Array<{ id: string }>> }; // registered runtimes → surface empty lanes too
  // The requester's own runner list (id + display label) — for personal queue (self:<id>) scoping/labeling. If unset, personal is empty.
  myRunners?: (subject: string) => Promise<Array<{ id: string; label?: string }>>;
  // Resolve the batch progress total (number of dataset cases) — omitted on failure (progress then shows child counts only).
  caseCountFor?: (tenant: string, datasetId: string, version: string) => Promise<number | undefined>;
  // Scheduler observability (main.ts injects the live Scheduler/CircuitBreaker) — powers lane admission + the
  // workspace scheduler slice. All cross-tenant numbers are filtered here, inside the service.
  schedulerStats?: () => {
    queued: number;
    inFlight: Record<string, number>;
    memInFlightMb: Record<string, number>;
    cpuInFlight?: Record<string, number>;
    tenantInFlight: Record<string, number>;
    queuedByTenant: Record<string, number>;
  };
  circuitStats?: () => Record<string, { consecutive: number; open: boolean }>;
  // The live Scheduler's OWN wait queue (effective scan order, all tenants) + its per-entry controls. The
  // service is the tenant boundary: snapshot filters entries, cancel/promote refuse another workspace's id.
  schedulerQueue?: () => SchedulerQueueEntryView[];
  cancelSchedulerEntry?: (id: string) => boolean;
  promoteSchedulerEntry?: (id: string) => boolean;
  tenantQuotaFor?: (tenant: string) => number | undefined; // the operator quota dial (EVERDICT_TENANT_QUOTAS)
  // The runtime's declared admission envelope (RuntimeSpec.maxConcurrent/memoryBudgetMb) — latest version.
  runtimeEnvelopeFor?: (
    tenant: string,
    runtimeId: string,
  ) => Promise<{ maxConcurrent?: number; memoryBudgetMb?: number; cpuBudget?: number } | undefined>;
  upcomingPerLane?: number;
  now?: () => string;
}

// The two lifecycle states this snapshot is about. Typed by the closed union so the same set can narrow the
// READ as well as the array (perf review) — a `Set<string>` cannot be handed to a store filter that names the
// statuses, and widening the filter to take strings would be the wrong direction.
const ACTIVE_STATUSES: readonly RunStatus[] = ["queued", "running"];
const ACTIVE_SCORECARD_STATUSES: readonly ScorecardStatus[] = ["queued", "running"];
const ACTIVE = new Set<string>(ACTIVE_STATUSES);

export class QueueService {
  private readonly now: () => string;
  private readonly upcomingPerLane: number;

  constructor(private readonly deps: QueueServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.upcomingPerLane = deps.upcomingPerLane ?? 5;
  }

  async snapshot(tenant: string, subject?: string): Promise<QueueSnapshot> {
    const [cards, runs, schedules, runtimes, myRunners] = await Promise.all([
      // ── NARROWED IN THE STORE, NOT AFTER IT (perf review) ────────────────────────────────────────
      //
      // Both of these read the ACTIVE rows and nothing else, and both used to fetch the whole collection to
      // find them — `runs.list(tenant)` in particular is `SELECT *` over the run ledger with no limit, so it
      // carried every finished run's `result` jsonb (snapshots included) to count the handful still moving.
      // The queue screen polls; the cost of one poll grew with everything the workspace had ever executed.
      this.deps.scorecards.list(tenant, { statuses: [...ACTIVE_SCORECARD_STATUSES] }),
      this.deps.runs ? this.deps.runs.list(tenant, { statuses: ACTIVE_STATUSES }) : Promise.resolve([]),
      this.deps.schedules ? this.deps.schedules.list(tenant).catch(() => []) : Promise.resolve([]),
      this.deps.runtimes ? this.deps.runtimes.list(tenant).catch(() => []) : Promise.resolve([]),
      subject && this.deps.myRunners ? this.deps.myRunners(subject).catch(() => []) : Promise.resolve([]),
    ]);

    const activeCards = cards.filter((c) => ACTIVE.has(c.status));
    // runs.list defaults to standalone only — batch children are folded into the parent's progress (avoids double counting).
    const activeRuns = runs.filter((r) => ACTIVE.has(r.status));

    // Progress of running batches — child run counts (+ total number of dataset cases, omitted if resolution fails).
    //
    // ── ONE GROUPED READ, NOT ONE READ PER BATCH (perf review) ────────────────────────────────────
    //
    // This used to call `runs.list(tenant, { scorecardId: c.id })` inside the map — N+1 in the number of
    // running batches, and each of the N was `SELECT *` over every child of a batch that may hold six
    // hundred cases, carrying each one's `result` jsonb, to produce three integers. `countChildrenByStatus`
    // asks the question the screen is actually asking, for every batch at once.
    const running = activeCards.filter((c) => c.status === "running");
    const childCounts =
      this.deps.runs === undefined
        ? []
        : await this.deps.runs.countChildrenByStatus(
            tenant,
            running.map((c) => c.id),
          );
    const countOf = (scorecardId: string, statuses: readonly RunStatus[]): number =>
      childCounts
        .filter((row) => row.scorecardId === scorecardId && statuses.includes(row.status))
        .reduce((sum, row) => sum + row.count, 0);
    const progressOf = new Map<string, QueueItem["progress"]>();
    await Promise.all(
      running.map(async (c) => {
        const done = countOf(c.id, ["succeeded", "failed"]);
        const active = countOf(c.id, ["running"]);
        // Fan-out parked behind the runtime's runners/slots — dispatched but not yet leased/executing. This is the
        // count that was previously invisible: a concurrency-8 batch on one runner reads as active 1 / waiting 7.
        const waiting = countOf(c.id, ["queued"]);
        // A partial run's denominator is the SELECTED subset size — "9/601" for a 12-case subset misreads as 1% done.
        const total =
          c.subset?.selected ??
          (this.deps.caseCountFor
            ? await this.deps.caseCountFor(tenant, c.dataset.id, c.dataset.version).catch(() => undefined)
            : undefined);
        progressOf.set(c.id, { done, active, waiting, ...(total !== undefined ? { total } : {}) });
      }),
    );

    const items: Array<{ lane: string; item: QueueItem }> = [
      ...activeCards.map((c) => ({
        lane: c.runtime ?? "",
        item: {
          type: "scorecard" as const,
          id: c.id,
          status: c.status as "queued" | "running",
          dataset: c.dataset,
          harness: c.harness,
          ...(c.origin?.source ? { trigger: c.origin.source } : {}),
          ...(c.createdBy ? { createdBy: c.createdBy } : {}),
          createdAt: c.createdAt,
          ...(progressOf.has(c.id) ? { progress: progressOf.get(c.id) } : {}),
        },
      })),
      ...activeRuns.map((r) => ({
        lane: r.runtime ?? "",
        item: {
          type: "run" as const,
          id: r.id,
          status: r.status as "queued" | "running",
          harness: r.harness,
          caseId: r.caseId,
          ...(r.trigger ? { trigger: r.trigger } : {}),
          ...(r.createdBy ? { createdBy: r.createdBy } : {}),
          createdAt: r.createdAt,
        },
      })),
    ];

    // Next fires of active schedules (only when Temporal-computed nextFireTimes exist — cron approximation is the web display's concern).
    const upcoming: Array<{ lane: string; entry: QueueUpcoming }> = [];
    for (const s of schedules) {
      if (!s.enabled) continue;
      const at = s.nextFireTimes?.[0];
      if (!at) continue;
      upcoming.push({
        lane: s.runTemplate.runtime ?? "",
        entry: {
          scheduleId: s.id,
          name: s.name,
          at,
          // A pull-mode (trace-evaluation) schedule has no dataset/harness — surface the trace-eval sentinel (the web
          // relabels it), same as the scorecard record it will produce.
          dataset: s.runTemplate.dataset?.id ?? TRACE_EVAL_REF,
          harness: s.runTemplate.harness?.id ?? TRACE_EVAL_REF,
        },
      });
    }

    // Scope split — workspace: default ('') + registered runtimes (shared). personal: my runners (self:<id>) only.
    // Another member's self:* items go into neither (the personal queue is personal only).
    const registered = new Set(runtimes.map((r) => r.id));
    const mySelfLanes = new Set(myRunners.map((r) => `self:${r.id}`));
    const runnerLabel = new Map<string, string | undefined>(myRunners.map((r) => [`self:${r.id}`, r.label]));
    const isSelf = (lane: string): boolean => lane.startsWith("self:");

    const wsLaneKeys = new Set<string>(["", ...registered]);
    for (const { lane } of items) if (!isSelf(lane)) wsLaneKeys.add(lane);
    for (const { lane } of upcoming) if (!isSelf(lane)) wsLaneKeys.add(lane);

    const personalLaneKeys = new Set<string>(mySelfLanes);
    for (const { lane } of items) if (mySelfLanes.has(lane)) personalLaneKeys.add(lane);

    // Scheduler admission view per workspace lane. A tenant runtime's backend registers as rt:<tenant>:<id>@<ver>
    // (one instance per version — summed); a global env backend registers under its bare name; self-hosted lanes
    // are lease queues (no scheduler backend) → no admission. Cross-tenant filtering happens HERE: only names
    // derived from THIS tenant (or the shared global backends' aggregate load) ever leave the service.
    const stats = this.deps.schedulerStats?.();
    const circuits = this.deps.circuitStats?.();
    const admissions = new Map<string, QueueLaneAdmission>();
    if (stats) {
      const laneMatches = (lane: string, name: string): boolean =>
        lane === ""
          ? !name.startsWith("rt:") && !name.startsWith("self:")
          : name === lane || name.startsWith(`rt:${tenant}:${lane}@`);
      await Promise.all(
        [...wsLaneKeys].map(async (lane) => {
          const sum = (m: Record<string, number>): number =>
            Object.entries(m)
              .filter(([n]) => laneMatches(lane, n))
              .reduce((a, [, v]) => a + v, 0);
          const inFlight = sum(stats.inFlight);
          const mem = sum(stats.memInFlightMb);
          const cpu = sum(stats.cpuInFlight ?? {});
          const circuit = circuits?.[`${tenant}:${lane}`];
          const envelope =
            lane !== "" && this.deps.runtimeEnvelopeFor
              ? await this.deps.runtimeEnvelopeFor(tenant, lane).catch(() => undefined)
              : undefined;
          admissions.set(lane, {
            inFlight,
            ...(mem > 0 || envelope?.memoryBudgetMb !== undefined ? { memInFlightMb: mem } : {}),
            ...(envelope?.memoryBudgetMb !== undefined ? { memoryBudgetMb: envelope.memoryBudgetMb } : {}),
            ...(cpu > 0 || envelope?.cpuBudget !== undefined ? { cpuInFlight: cpu } : {}),
            ...(envelope?.cpuBudget !== undefined ? { cpuBudget: envelope.cpuBudget } : {}),
            ...(envelope?.maxConcurrent !== undefined ? { maxConcurrent: envelope.maxConcurrent } : {}),
            ...(circuit ? { circuit: { open: circuit.open, consecutive: circuit.consecutive } } : {}),
          });
        }),
      );
    }

    const byCreatedAsc = (a: QueueItem, b: QueueItem): number => a.createdAt.localeCompare(b.createdAt);
    const buildLane = (key: string): QueueLane => ({
      runtime: key,
      ...(runnerLabel.get(key) ? { label: runnerLabel.get(key) } : {}),
      registered: registered.has(key),
      ...(admissions.has(key) ? { admission: admissions.get(key) } : {}),
      running: items
        .filter((x) => x.lane === key && x.item.status === "running")
        .map((x) => x.item)
        .sort(byCreatedAsc),
      queued: items
        .filter((x) => x.lane === key && x.item.status === "queued")
        .map((x) => x.item)
        .sort(byCreatedAsc), // FIFO — the front is the next item
      upcoming: upcoming
        .filter((x) => x.lane === key)
        .map((x) => x.entry)
        .sort((a, b) => a.at.localeCompare(b.at))
        .slice(0, this.upcomingPerLane),
    });

    const workspace = [...wsLaneKeys]
      .sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b))) // put the default backend lane at the top
      .map(buildLane);
    const personal = [...personalLaneKeys].sort().map(buildLane);

    // totals counts visible items only — another member's personal (self) items are excluded from the tallies too.
    const visibleLanes = new Set([...wsLaneKeys, ...personalLaneKeys]);
    const visible = items.filter((x) => visibleLanes.has(x.lane));
    const quota = this.deps.tenantQuotaFor?.(tenant);
    return {
      generatedAt: this.now(),
      totals: {
        running: visible.filter((x) => x.item.status === "running").length,
        queued: visible.filter((x) => x.item.status === "queued").length,
        upcoming: upcoming.filter((x) => !isSelf(x.lane) || mySelfLanes.has(x.lane)).length,
      },
      ...(stats
        ? {
            scheduler: {
              queued: stats.queuedByTenant[tenant] ?? 0,
              inFlight: stats.tenantInFlight[tenant] ?? 0,
              ...(quota !== undefined && Number.isFinite(quota) ? { quota } : {}),
              ...(this.deps.schedulerQueue ? { entries: this.schedulerEntries(tenant) } : {}),
            },
          }
        : {}),
      workspace,
      personal,
    };
  }

  // THIS workspace's scheduler entries in effective scan order — the cross-tenant filter lives here, inside the
  // service (same rule as the admission view): another tenant's entries never leave the control plane.
  private schedulerEntries(tenant: string): QueueSchedulerEntry[] {
    const all = this.deps.schedulerQueue?.() ?? [];
    const nowMs = Date.parse(this.now());
    return all
      .filter((e) => e.tenant === tenant)
      .map(({ tenant: _tenant, enqueuedAt, ...entry }, index) => ({
        ...entry,
        enqueuedAt: new Date(enqueuedAt).toISOString(),
        waitedMs: Math.max(0, nowMs - enqueuedAt),
        position: index + 1,
      }));
  }

  // Look up one scheduler entry with the tenant guard — another workspace's id (or a settled/unknown one) is
  // NOT_FOUND, never FORBIDDEN: existence must not leak across the trust boundary.
  private ownedEntry(tenant: string, id: string): SchedulerQueueEntryView {
    const entry = this.deps.schedulerQueue?.().find((e) => e.id === id);
    if (!entry || entry.tenant !== tenant)
      throw new NotFoundError("NOT_FOUND", { entry: id }, "queue entry not found (already placed or settled?).");
    return entry;
  }

  // Cancel ONE waiting scheduler entry (the queue page's kill switch). The rejection settles through the
  // dispatch caller's existing machinery (a single run fails CANCELLED; a batch case freezes/retries by its
  // own policy) — this only removes the WAITING entry, in-flight work is untouched.
  cancelSchedulerEntry(tenant: string, id: string): { cancelled: true } {
    const entry = this.ownedEntry(tenant, id);
    if (!this.deps.cancelSchedulerEntry?.(entry.id))
      throw new NotFoundError("NOT_FOUND", { entry: id }, "queue entry not found (already placed or settled?).");
    return { cancelled: true };
  }

  // Move ONE waiting scheduler entry to the front of the effective order ("run this next").
  promoteSchedulerEntry(tenant: string, id: string): { promoted: true } {
    const entry = this.ownedEntry(tenant, id);
    if (!this.deps.promoteSchedulerEntry?.(entry.id))
      throw new NotFoundError("NOT_FOUND", { entry: id }, "queue entry not found (already placed or settled?).");
    return { promoted: true };
  }
}
