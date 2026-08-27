import type {
  AgentTaskStore,
  ApprovalStore,
  CycleStore,
  InitiativeStore,
  IssueStore,
  PlatformEventStore,
  ProjectStore,
  ScorecardStore,
} from "@everdict/application-control";
import {
  type IssueStatus,
  OPEN_ISSUE_STATUSES,
  type PlatformEventDailyCount,
  type ScorecardRecord,
  type WorkspacePulse,
} from "@everdict/contracts";
import {
  type WeightedRate,
  activityTrend,
  addCalendarDays,
  calendarSpan,
  flowTrend,
  headlinePassRate,
  qualityTrend,
  weightedMeanPassRate,
} from "@everdict/domain";

// The workspace PULSE — one read that answers "how is this workspace doing" (docs/architecture/workspace-pulse.md).
//
// This service exists because the question spans every domain: the tracker's open work, the iterations running,
// the goals somebody flagged, the agents' unfinished tasks, and what the evals scored. A screen assembling that
// from eight list endpoints pays for eight round trips and re-derives arithmetic that belongs here — and gets
// slower every time the product grows another axis.
//
// It composes STORES, never peer services (the api-layer rule): cross-resource data comes from the owning store.
// The two questions it does NOT answer itself are handed in by the transport, because only the transport knows
// them — who is asking (`visibleTeams`, resolved by the one place team privacy is decided) and when "now" is.

// A project counts as "in flight" while somebody could still work on it. `paused` is in: work that stopped
// without being abandoned is still a commitment the workspace carries, and hiding it is how a paused project
// stays paused for a quarter without anyone noticing.
const LIVE_PROJECT_STATUSES = new Set(["backlog", "planned", "in_progress", "paused"]);

// The same reading one level up. `planned` is IN, and finding that out cost a live drill: a goal is born
// planned, so counting only `active` answered "0 goals" for a workspace that had just created one — a tile
// that says zero about something you can see in the list is worse than no tile.
const LIVE_INITIATIVE_STATUSES = new Set(["planned", "active"]);

// A cycle closing within this many days is what a planning conversation is about.
const ENDING_SOON_DAYS = 7;

export interface WorkspacePulseDeps {
  issues: IssueStore;
  cycles: CycleStore;
  projects: ProjectStore;
  initiatives: InitiativeStore;
  tasks: AgentTaskStore;
  approvals: ApprovalStore;
  scorecards: ScorecardStore;
  // The recorded past. Optional because a deployment can compose without a log — the counts still answer, and
  // the trend comes back empty rather than the whole screen 404ing.
  events?: PlatformEventStore;
  now?: () => Date;
}

export interface WorkspacePulseQuery {
  tenant: string;
  // How many days the trend covers, today included.
  days: number;
  // The teams whose work this caller may read — `undefined` means nothing is hidden, never "no teams".
  visibleTeams?: string[];
}

export class WorkspacePulseService {
  private readonly now: () => Date;

  constructor(private readonly deps: WorkspacePulseDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async read(query: WorkspacePulseQuery): Promise<WorkspacePulse> {
    const { tenant, days } = query;
    const now = this.now();
    // Whole UTC days, today included — the same boundary the usage series uses, so the two can be read side by
    // side. The window ENDS at this instant rather than at midnight: a dashboard that stops counting at the top
    // of the day would show today as empty for its first hour every morning.
    const today = now.toISOString().slice(0, 10);
    const firstDay = addCalendarDays(today, -(days - 1));
    const window = { from: `${firstDay}T00:00:00.000Z`, to: now.toISOString(), days };
    // The window before this one, same length — the other half of every "vs. previous" delta.
    const priorFrom = `${addCalendarDays(firstDay, -days)}T00:00:00.000Z`;
    const spine = calendarSpan(firstDay, today);
    const teamScope = query.visibleTeams === undefined ? {} : { teamIds: query.visibleTeams };

    const [
      byStatus,
      openCycles,
      cycleTotals,
      cycleOpen,
      projects,
      initiatives,
      pending,
      running,
      approvals,
      batches,
      buckets,
    ] = await Promise.all([
      this.deps.issues.countByGroup(tenant, "status", teamScope),
      this.deps.cycles.list(tenant, { open: true }),
      this.deps.issues.countByGroup(tenant, "cycle", teamScope),
      this.deps.issues.countByGroup(tenant, "cycle", { ...teamScope, statuses: [...OPEN_ISSUE_STATUSES] }),
      this.deps.projects.list(tenant),
      this.deps.initiatives.list(tenant),
      this.deps.tasks.list(tenant, { status: "pending" }),
      this.deps.tasks.list(tenant, { status: "in_progress" }),
      this.deps.approvals.list(tenant, { status: "pending" }),
      this.deps.scorecards.list(tenant, query.visibleTeams === undefined ? {} : { visibleTeams: query.visibleTeams }),
      this.deps.events?.dailyCounts(tenant, { from: window.from, to: window.to }) ?? Promise.resolve([]),
    ]);

    const issueCount = (status: IssueStatus): number => byStatus.find((g) => g.key === status)?.count ?? 0;
    const open = OPEN_ISSUE_STATUSES.reduce((sum, status) => sum + issueCount(status), 0);

    // A cycle's commitment is the issues it holds; what is finished is the rest of them. Both come from the same
    // grouped aggregate, so the two halves cannot disagree the way two separate reads would.
    const activeCycleIds = new Set(openCycles.map((cycle) => cycle.id));
    const committed = sumForKeys(cycleTotals, activeCycleIds);
    const stillOpen = sumForKeys(cycleOpen, activeCycleIds);
    const endingBy = addCalendarDays(today, ENDING_SOON_DAYS);

    const liveProjects = projects.filter((project) => LIVE_PROJECT_STATUSES.has(project.status));
    const liveInitiatives = initiatives.filter((initiative) => LIVE_INITIATIVE_STATUSES.has(initiative.status));
    const atRisk =
      liveProjects.filter((project) => isFlagged(project.health)).length +
      liveInitiatives.filter((initiative) => isFlagged(initiative.health)).length;

    // The window's batches and the preceding window's, from one list read. `createdAt` dates a batch by when it
    // was SUBMITTED — the run's own day. A batch that straddles midnight lands on the day it started, which is
    // the day people would name it by.
    const inWindow = batchesBetween(batches, window.from, window.to);
    const before = batchesBetween(batches, priorFrom, window.from);

    return {
      window,
      work: {
        open,
        inProgress: issueCount("in_progress") + issueCount("in_review"),
        regressed: issueCount("regressed"),
      },
      cycles: {
        active: openCycles.length,
        committed,
        done: committed - stillOpen,
        endingSoon: openCycles.filter((cycle) => cycle.endsAt <= endingBy).length,
      },
      goals: {
        initiatives: liveInitiatives.length,
        projects: liveProjects.length,
        atRisk,
      },
      agents: {
        runs: countKinds(buckets, ["agent.run.completed", "agent.run.failed"]),
        openTasks: pending.length + running.length,
        awaitingApproval: approvals.length,
      },
      evaluation: {
        scorecards: inWindow.length,
        // Executions are counted from the log rather than from the run ledger: what finished INSIDE a window is
        // a question about facts with timestamps, and the ledger would have to be paged to answer it.
        runs: countKinds(buckets, ["run.completed", "run.failed"]),
        failed: countKinds(buckets, ["run.failed"]),
        // Quality rates read SUCCEEDED batches only — a failed/cancelled/superseded batch's partial rate is
        // not a product quality signal (the analysis engine excludes exactly these; the dashboard must agree),
        // and a superseded retry would double-count its replacement.
        ...optionalRate("passRate", weightedMeanPassRate(ratesOf(succeededIn(inWindow)))),
        ...optionalRate("passRateBefore", weightedMeanPassRate(ratesOf(succeededIn(before)))),
      },
      trend: {
        activity: activityTrend(buckets, spine),
        flow: flowTrend(buckets, spine),
        quality: qualityTrend(
          succeededIn(inWindow).map((batch) => ({
            day: batch.createdAt.slice(0, 10),
            ...optionalRate("passRate", rateOf(batch)),
          })),
          spine,
        ),
      },
    };
  }
}

// The counts for a chosen set of group keys. A group whose key is absent (`null` — issues in no cycle at all)
// never matches, which is the point: uncommitted work is not part of any iteration's commitment.
function sumForKeys(groups: readonly { key: string | null; count: number }[], keys: ReadonlySet<string>): number {
  return groups.reduce((sum, group) => (group.key !== null && keys.has(group.key) ? sum + group.count : sum), 0);
}

function countKinds(buckets: readonly PlatformEventDailyCount[], kinds: readonly string[]): number {
  return buckets.reduce((sum, bucket) => (kinds.includes(bucket.kind) ? sum + bucket.count : sum), 0);
}

// Somebody looked at this and said it is not going well. Absent health is NOT at risk — nobody has reported yet,
// and treating silence as an alarm would make every new project red.
function isFlagged(health: string | undefined): boolean {
  return health === "at_risk" || health === "off_track";
}

// Quality-rate eligibility: only a batch that actually completed carries a defensible rate.
function succeededIn(batches: readonly ScorecardRecord[]): ScorecardRecord[] {
  return batches.filter((batch) => batch.status === "succeeded");
}

function batchesBetween(batches: readonly ScorecardRecord[], from: string, to: string): ScorecardRecord[] {
  return batches.filter((batch) => batch.createdAt >= from && batch.createdAt < to);
}

// The served headline ranking, never a re-implementation: `headlinePassRate` is what a scorecard's own verdict
// reads, so the dashboard's number and the detail page's number are the same number.
function rateOf(batch: ScorecardRecord): number | undefined {
  return headlinePassRate(batch) ?? undefined;
}

// rate + the cases behind it — the weight keeps a 3-case smoke run from moving the headline like a 500-case
// suite. Weight = the largest measured count among the batch's pass-rate-bearing metrics (1 when unknown).
function ratesOf(batches: readonly ScorecardRecord[]): WeightedRate[] {
  return batches.flatMap((batch) => {
    const rate = rateOf(batch);
    if (rate === undefined) return [];
    const weight = Math.max(1, ...(batch.summary ?? []).filter((m) => m.passRate !== undefined).map((m) => m.count));
    return [{ rate, weight }];
  });
}

// A rate that was never measured is left OFF the object rather than sent as zero — the contract marks it
// optional precisely so a reader can tell "nothing to report" from "everything failed".
function optionalRate<K extends string>(key: K, rate: number | undefined): Partial<Record<K, number>> {
  return rate === undefined ? {} : ({ [key]: rate } as Record<K, number>);
}
