import {
  InitiativeRecordSchema,
  type IssueRecord,
  IssueRecordSchema,
  type IssueStatus,
  type PlatformEventKind,
  ProjectRecordSchema,
  type ScorecardRecord,
  type TrackerHealth,
} from "@everdict/contracts";
import {
  InMemoryAgentTaskStore,
  InMemoryApprovalStore,
  InMemoryInitiativeStore,
  InMemoryIssueStore,
  InMemoryPlatformEventStore,
  InMemoryProjectStore,
  InMemoryScorecardStore,
} from "@everdict/db";
import { beforeEach, describe, expect, it } from "vitest";
import { WorkspacePulseService } from "./workspace-pulse-service.js";

// The pulse is arithmetic over five domains, so these tests are about what the numbers MEAN — which issues
// count as open, when a goal is "at risk", and where the window's edges fall.

const TENANT = "acme";
const NOW = new Date("2026-08-04T09:00:00.000Z"); // a Tuesday, mid-morning

let issues: InMemoryIssueStore;
let projects: InMemoryProjectStore;
let initiatives: InMemoryInitiativeStore;
let tasks: InMemoryAgentTaskStore;
let approvals: InMemoryApprovalStore;
let scorecards: InMemoryScorecardStore;
let events: InMemoryPlatformEventStore;
let seq = 0;

beforeEach(() => {
  issues = new InMemoryIssueStore();
  projects = new InMemoryProjectStore();
  initiatives = new InMemoryInitiativeStore();
  tasks = new InMemoryAgentTaskStore();
  approvals = new InMemoryApprovalStore();
  scorecards = new InMemoryScorecardStore();
  events = new InMemoryPlatformEventStore();
  seq = 0;
});

function service(days = 7): { read: () => ReturnType<WorkspacePulseService["read"]> } {
  const svc = new WorkspacePulseService({
    issues,
    projects,
    initiatives,
    tasks,
    approvals,
    scorecards,
    events,
    now: () => NOW,
  });
  return { read: () => svc.read({ tenant: TENANT, days }) };
}

async function issue(status: IssueStatus, extra: Partial<IssueRecord> = {}): Promise<void> {
  seq += 1;
  await issues.create(
    IssueRecordSchema.parse({
      id: `i-${seq}`,
      tenant: TENANT,
      number: seq,
      identifier: `ENG-${seq}`,
      title: `issue ${seq}`,
      status,
      createdBy: "u-1",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      ...extra,
    }),
  );
}

async function initiative(status: string, health?: TrackerHealth): Promise<void> {
  seq += 1;
  await initiatives.create(
    InitiativeRecordSchema.parse({
      id: `n-${seq}`,
      tenant: TENANT,
      name: `goal ${seq}`,
      status,
      ...(health !== undefined ? { health } : {}),
      createdBy: "u-1",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    }),
  );
}

async function project(status: string, health?: TrackerHealth): Promise<void> {
  seq += 1;
  await projects.create(
    ProjectRecordSchema.parse({
      id: `p-${seq}`,
      tenant: TENANT,
      name: `project ${seq}`,
      status,
      ...(health !== undefined ? { health } : {}),
      createdBy: "u-1",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    }),
  );
}

async function fact(kind: PlatformEventKind, createdAt: string, payload: Record<string, unknown> = {}): Promise<void> {
  seq += 1;
  await events.append({
    id: `ev-${seq}`,
    tenant: TENANT,
    kind,
    subject: { type: "issue", id: `i-${seq}` },
    payload,
    message: kind,
    createdAt,
  });
}

async function batch(createdAt: string, passRate?: number): Promise<void> {
  seq += 1;
  await scorecards.create({
    id: `sc-${seq}`,
    tenant: TENANT,
    status: "succeeded",
    dataset: { id: "d-1", version: "1.0.0" },
    harness: { id: "h-1", version: "1.0.0" },
    ...(passRate !== undefined ? { summary: [{ metric: "tests_pass", count: 10, passRate }] } : {}),
    createdAt,
  } as ScorecardRecord);
}

describe("the tracker's state right now", () => {
  it("counts everything that is not done or cancelled as open — a regression included", async () => {
    // Given: work in every status
    await issue("backlog");
    await issue("todo");
    await issue("in_progress");
    await issue("in_review");
    await issue("regressed");
    await issue("done");
    await issue("cancelled");

    // When: the pulse is read
    const pulse = await service().read();

    // Then: five are still open, the two started ones plus the review are in flight, and the regression is
    // called out on its own — a resolution that stopped holding is the one number somebody must act on
    expect(pulse.work).toEqual({ open: 5, inProgress: 2, regressed: 1 });
  });
});

describe("the goals", () => {
  it("counts a paused project as in flight — stopped is not finished", async () => {
    await project("in_progress");
    await project("paused");
    await project("completed");
    await project("cancelled");
    const pulse = await service().read();
    expect(pulse.goals.projects).toBe(2);
  });

  it("counts a goal that is still PLANNED — a goal is born planned, and a home that says 0 is lying", async () => {
    // Given: one goal nobody has started, one under way, and two that are over
    await initiative("planned");
    await initiative("active");
    await initiative("completed");
    await initiative("cancelled");

    // When
    const pulse = await service().read();

    // Then: both live goals count. (Live drill 2026-08-04: filtering the read to `active` answered zero for a
    // workspace that had just created its first goal.)
    expect(pulse.goals.initiatives).toBe(2);
  });

  it("treats silence as unreported, never as an alarm", async () => {
    // Given: one project somebody flagged, one they said is fine, and one nobody has reported on
    await project("in_progress", "off_track");
    await project("in_progress", "on_track");
    await project("in_progress");
    const pulse = await service().read();
    // Then: only the flagged one is at risk
    expect(pulse.goals.atRisk).toBe(1);
  });
});

describe("the evaluated half", () => {
  it("compares the window's pass rate against the window before it", async () => {
    // Given: two batches inside a 7-day window (Jul 29 – Aug 4) and one in the 7 days before it
    await batch("2026-08-03T10:00:00.000Z", 0.9);
    await batch("2026-08-01T10:00:00.000Z", 0.7);
    await batch("2026-07-25T10:00:00.000Z", 0.4);

    // When
    const pulse = await service(7).read();

    // Then: the headline is this window's mean, and the comparison is the previous window's — so the screen can
    // say "up from 40%" instead of asking the reader to remember
    expect(pulse.evaluation.scorecards).toBe(2);
    expect(pulse.evaluation.passRate).toBeCloseTo(0.8);
    expect(pulse.evaluation.passRateBefore).toBeCloseTo(0.4);
  });

  it("reports no pass rate at all rather than zero when nothing was measured", async () => {
    await batch("2026-08-03T10:00:00.000Z");
    const pulse = await service(7).read();
    expect(pulse.evaluation.scorecards).toBe(1);
    expect(pulse.evaluation).not.toHaveProperty("passRate");
  });

  it("counts executions from the recorded facts, failures included", async () => {
    await fact("run.completed", "2026-08-03T10:00:00.000Z");
    await fact("run.completed", "2026-08-03T11:00:00.000Z");
    await fact("run.failed", "2026-08-04T08:00:00.000Z");
    const pulse = await service(7).read();
    expect(pulse.evaluation).toMatchObject({ runs: 3, failed: 1 });
  });
});

describe("the window", () => {
  it("spans whole UTC days and ends at NOW, so today is never a blank column", async () => {
    const pulse = await service(3).read();
    expect(pulse.window).toEqual({ from: "2026-08-02T00:00:00.000Z", to: NOW.toISOString(), days: 3 });
    expect(pulse.trend.activity.map((p) => p.date)).toEqual(["2026-08-02", "2026-08-03", "2026-08-04"]);
  });

  it("draws the issue flow from the facts, with a cancellation counted as work leaving the board", async () => {
    await fact("issue.created", "2026-08-03T09:00:00.000Z");
    await fact("issue.created", "2026-08-03T10:00:00.000Z");
    await fact("issue.status_changed", "2026-08-03T12:00:00.000Z", { to: "done" });
    await fact("issue.status_changed", "2026-08-03T13:00:00.000Z", { to: "cancelled" });
    await fact("issue.status_changed", "2026-08-03T14:00:00.000Z", { to: "in_progress" });

    const pulse = await service(3).read();

    expect(pulse.trend.flow).toEqual([
      { date: "2026-08-02", created: 0, completed: 0 },
      { date: "2026-08-03", created: 2, completed: 2 },
      { date: "2026-08-04", created: 0, completed: 0 },
    ]);
  });

  it("splits the day's facts across the four axes", async () => {
    await fact("issue.created", "2026-08-04T01:00:00.000Z");
    await fact("scorecard.completed", "2026-08-04T02:00:00.000Z");
    await fact("agent.run.completed", "2026-08-04T03:00:00.000Z");
    await fact("file.published", "2026-08-04T04:00:00.000Z");

    const pulse = await service(2).read();

    expect(pulse.trend.activity.at(-1)).toEqual({
      date: "2026-08-04",
      work: 1,
      evaluation: 1,
      agent: 1,
      knowledge: 1,
      total: 4,
    });
  });
});

describe("without an event log", () => {
  it("still answers the counts, with an empty trend rather than a failure", async () => {
    // Given: a deployment composed with no platform-event store
    await issue("todo");
    const svc = new WorkspacePulseService({
      issues,
      projects,
      initiatives,
      tasks,
      approvals,
      scorecards,
      now: () => NOW,
    });

    // When
    const pulse = await svc.read({ tenant: TENANT, days: 3 });

    // Then: the state is intact and the series are zeroed spines, not missing keys
    expect(pulse.work.open).toBe(1);
    expect(pulse.trend.activity.every((p) => p.total === 0)).toBe(true);
    expect(pulse.trend.flow).toHaveLength(3);
  });
});
