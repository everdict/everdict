import type { CycleRecord, IssueRecord } from "@everdict/contracts";
import { IssueRecordSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  Cycle,
  alignToStartDay,
  cycleBurndown,
  cycleDaysRemaining,
  cyclePipelinePlan,
  issueInCycleOn,
  issueStatusOn,
  nextCycleWindow,
} from "./cycle.js";

// 2026-08-03 is a Monday, so every date in here can be read as a weekday without counting.
const MONDAY = "2026-08-03";
const CADENCE = { durationWeeks: 2, startDay: 1 };

function cycle(overrides: Partial<CycleRecord> = {}): CycleRecord {
  return Cycle.newCycle({
    id: overrides.id ?? "cycle-1",
    tenant: "acme",
    teamId: "team-1",
    number: overrides.number ?? 1,
    startsAt: overrides.startsAt ?? MONDAY,
    endsAt: overrides.endsAt ?? "2026-08-16",
    createdBy: "dana",
    now: "2026-08-03T09:00:00.000Z",
  });
}

function closed(record: CycleRecord, at = "2026-08-17T09:00:00.000Z"): CycleRecord {
  return { ...record, completedAt: at };
}

function issue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return IssueRecordSchema.parse({
    id: "issue-1",
    tenant: "acme",
    teamId: "team-1",
    identifier: "ENG-1",
    number: 1,
    title: "Judge the trace",
    status: "todo",
    createdBy: "dana",
    createdAt: "2026-08-03T09:00:00.000Z",
    updatedAt: "2026-08-03T09:00:00.000Z",
    ...overrides,
  });
}

describe("cycle window alignment", () => {
  it("aligns a first cycle BACKWARD to the team's start weekday, so the team is inside it today", () => {
    // Wednesday 2026-08-05 with a Monday cadence → the cycle running today started on the 3rd.
    expect(alignToStartDay("2026-08-05", 1)).toBe(MONDAY);
    expect(nextCycleWindow(undefined, "2026-08-05", CADENCE)).toEqual({
      startsAt: MONDAY,
      endsAt: "2026-08-16",
    });
  });

  it("leaves a date that already falls on the start weekday alone", () => {
    expect(alignToStartDay(MONDAY, 1)).toBe(MONDAY);
  });

  it("continues a live sequence contiguously rather than re-aligning it into a gap", () => {
    expect(nextCycleWindow("2026-08-16", MONDAY, CADENCE)).toEqual({
      startsAt: "2026-08-17",
      endsAt: "2026-08-30",
    });
  });

  it("restarts from today's aligned weekday when the last cycle already ended", () => {
    // The team paused for a month — the next cycle is the one it is in now, not a backfill of the gap.
    expect(nextCycleWindow("2026-07-05", "2026-08-05", CADENCE)).toEqual({
      startsAt: MONDAY,
      endsAt: "2026-08-16",
    });
  });

  it("ends the window inclusively, so consecutive cycles never share a boundary day", () => {
    const first = nextCycleWindow(undefined, MONDAY, { durationWeeks: 1, startDay: 1 });
    const second = nextCycleWindow(first.endsAt, MONDAY, { durationWeeks: 1, startDay: 1 });
    expect(first.endsAt).toBe("2026-08-09");
    expect(second.startsAt).toBe("2026-08-10");
  });
});

describe("cyclePipelinePlan — what has to exist for a team with cycles on", () => {
  it("stands up the current cycle plus the requested upcoming ones for a team with none", () => {
    const plan = cyclePipelinePlan([], MONDAY, CADENCE, 2);
    expect(plan).toEqual([
      { startsAt: MONDAY, endsAt: "2026-08-16" },
      { startsAt: "2026-08-17", endsAt: "2026-08-30" },
      { startsAt: "2026-08-31", endsAt: "2026-09-13" },
    ]);
  });

  it("plans nothing when the pipeline is already deep enough", () => {
    const running = cycle();
    const ahead = cycle({ id: "cycle-2", number: 2, startsAt: "2026-08-17", endsAt: "2026-08-30" });
    expect(cyclePipelinePlan([ahead, running], MONDAY, CADENCE, 1)).toEqual([]);
  });

  it("tops the pipeline back up to depth rather than starting over", () => {
    const running = cycle();
    expect(cyclePipelinePlan([running], MONDAY, CADENCE, 2)).toEqual([
      { startsAt: "2026-08-17", endsAt: "2026-08-30" },
      { startsAt: "2026-08-31", endsAt: "2026-09-13" },
    ]);
  });

  it("counts a closed cycle as history even while its dates still run", () => {
    // Closed early: the team is no longer inside it, so one has to be stood up for today.
    const plan = cyclePipelinePlan([closed(cycle(), "2026-08-04T09:00:00.000Z")], MONDAY, CADENCE, 0);
    expect(plan).toEqual([{ startsAt: "2026-08-17", endsAt: "2026-08-30" }]);
  });

  it("keeps one standing cycle even when no upcoming ones were asked for", () => {
    expect(cyclePipelinePlan([], MONDAY, CADENCE, 0)).toHaveLength(1);
  });

  it("continues from the latest END date, so a hand-planned window cannot be overlapped", () => {
    const far = cycle({ id: "cycle-9", number: 9, startsAt: "2026-09-07", endsAt: "2026-09-20" });
    const near = cycle();
    // The far window is the one to continue from, even though it was planned second.
    expect(cyclePipelinePlan([near, far], MONDAY, CADENCE, 2)).toEqual([
      { startsAt: "2026-09-21", endsAt: "2026-10-04" },
    ]);
  });
});

describe("cycleDaysRemaining", () => {
  it("counts today as a day the team still has", () => {
    expect(cycleDaysRemaining(cycle(), "2026-08-16")).toBe(1);
    expect(cycleDaysRemaining(cycle(), MONDAY)).toBe(14);
  });

  it("is zero once the end date has passed rather than going negative", () => {
    expect(cycleDaysRemaining(cycle(), "2026-08-20")).toBe(0);
  });

  it("counts an upcoming cycle's whole window, not the wait before it", () => {
    expect(cycleDaysRemaining(cycle(), "2026-07-30")).toBe(14);
  });
});

describe("issueStatusOn — replaying an issue's status from its own history", () => {
  const moved = issue({
    status: "done",
    history: [
      {
        at: "2026-08-04T10:00:00.000Z",
        by: "dana",
        event: "status_changed",
        detail: { from: "todo", to: "in_progress" },
      },
      { at: "2026-08-07T10:00:00.000Z", by: "dana", event: "resolved", detail: { from: "in_progress", to: "done" } },
    ],
  });

  it("reports the status held at the end of the given day", () => {
    expect(issueStatusOn(moved, "2026-08-03")).toBe("todo");
    expect(issueStatusOn(moved, "2026-08-04")).toBe("in_progress");
    expect(issueStatusOn(moved, "2026-08-06")).toBe("in_progress");
    expect(issueStatusOn(moved, "2026-08-07")).toBe("done");
  });

  it("falls back to the current status for an issue that never moved", () => {
    expect(issueStatusOn(issue({ status: "backlog" }), MONDAY)).toBe("backlog");
  });

  it("ignores a history entry whose detail is not a status at all", () => {
    const noisy = issue({
      status: "todo",
      history: [{ at: "2026-08-04T10:00:00.000Z", by: "dana", event: "updated", detail: { changed: ["title"] } }],
    });
    expect(issueStatusOn(noisy, "2026-08-05")).toBe("todo");
  });
});

describe("issueInCycleOn — replaying which iteration held the issue", () => {
  const pulledIn = issue({
    cycleId: "cycle-1",
    history: [
      {
        at: "2026-08-06T10:00:00.000Z",
        by: "dana",
        event: "updated",
        detail: { changed: ["cycle"], cycleFrom: null, cycleTo: "cycle-1" },
      },
    ],
  });

  it("counts the issue only from the day it was pulled in", () => {
    expect(issueInCycleOn(pulledIn, "cycle-1", "2026-08-05")).toBe(false);
    expect(issueInCycleOn(pulledIn, "cycle-1", "2026-08-06")).toBe(true);
    expect(issueInCycleOn(pulledIn, "cycle-1", "2026-08-10")).toBe(true);
  });

  it("drops it again on the day it was moved out", () => {
    const movedOut = issue({
      cycleId: "cycle-2",
      history: [
        ...pulledIn.history,
        {
          at: "2026-08-09T10:00:00.000Z",
          by: "dana",
          event: "updated",
          detail: { changed: ["cycle"], cycleFrom: "cycle-1", cycleTo: "cycle-2" },
        },
      ],
    });
    expect(issueInCycleOn(movedOut, "cycle-1", "2026-08-08")).toBe(true);
    expect(issueInCycleOn(movedOut, "cycle-1", "2026-08-09")).toBe(false);
    // …and it joins the destination the same day, which is what the next cycle's burn-down needs.
    expect(issueInCycleOn(movedOut, "cycle-2", "2026-08-09")).toBe(true);
  });

  it("reconstructs the state BEFORE the first recorded move rather than guessing", () => {
    const movedOut = issue({
      cycleId: "cycle-2",
      history: [
        {
          at: "2026-08-09T10:00:00.000Z",
          by: "dana",
          event: "updated",
          detail: { changed: ["cycle"], cycleFrom: "cycle-1", cycleTo: "cycle-2" },
        },
      ],
    });
    expect(issueInCycleOn(movedOut, "cycle-1", "2026-08-04")).toBe(true);
  });

  it("counts an issue with NO recorded move for the whole window — the honest reading of a missing record", () => {
    // Every issue that predates cycle moves being recorded looks like this.
    expect(issueInCycleOn(issue({ cycleId: "cycle-1" }), "cycle-1", MONDAY)).toBe(true);
  });

  it("ignores an ordinary edit that touched no cycle", () => {
    const renamed = issue({
      cycleId: "cycle-1",
      history: [{ at: "2026-08-04T10:00:00.000Z", by: "dana", event: "updated", detail: { changed: ["title"] } }],
    });
    expect(issueInCycleOn(renamed, "cycle-1", "2026-08-05")).toBe(true);
  });
});

describe("cycleBurndown", () => {
  // The caller only ever passes issues the cycle HOLDS (`issues.list({cycleId})`), so every one of these
  // carries it — which is also what makes "no recorded move" mean "in it all along".
  const done = issue({
    id: "issue-1",
    cycleId: "cycle-1",
    estimate: 3,
    status: "done",
    history: [{ at: "2026-08-05T10:00:00.000Z", by: "dana", event: "resolved", detail: { from: "todo", to: "done" } }],
  });
  const open = issue({ id: "issue-2", cycleId: "cycle-1", estimate: 2, status: "in_progress" });

  it("draws one point per ELAPSED day, never into the future", () => {
    const points = cycleBurndown(cycle(), [done, open], "2026-08-06");
    expect(points.map((p) => p.date)).toEqual([MONDAY, "2026-08-04", "2026-08-05", "2026-08-06"]);
  });

  it("drops the points of an issue on the day it settled", () => {
    const points = cycleBurndown(cycle(), [done, open], "2026-08-06");
    expect(points.map((p) => p.remaining)).toEqual([5, 5, 2, 2]);
    expect(points.map((p) => p.remainingIssues)).toEqual([2, 2, 1, 1]);
    // Scope does not move — finishing work is not the same as never having committed to it.
    expect(points.map((p) => p.scope)).toEqual([5, 5, 5, 5]);
  });

  it("counts an unestimated issue in the issue count and not in the points", () => {
    const unestimated = issue({ id: "issue-3", cycleId: "cycle-1", status: "todo" });
    const [first] = cycleBurndown(cycle(), [unestimated], MONDAY);
    expect(first).toEqual({ date: MONDAY, scope: 0, remaining: 0, remainingIssues: 1 });
  });

  it("raises the scope on the day work was pulled in, not before it", () => {
    // Given: two points committed from the start, three more dragged in on the fourth day
    const added = issue({
      id: "issue-5",
      cycleId: "cycle-1",
      estimate: 3,
      status: "todo",
      history: [
        {
          at: "2026-08-06T09:00:00.000Z",
          by: "dana",
          event: "updated",
          detail: { changed: ["cycle"], cycleFrom: null, cycleTo: "cycle-1" },
        },
      ],
    });
    const points = cycleBurndown(cycle(), [open, added], "2026-08-07");
    // Then: the days before it arrived show the plan as it actually stood
    expect(points.map((p) => p.scope)).toEqual([2, 2, 2, 5, 5]);
    expect(points.map((p) => p.remaining)).toEqual([2, 2, 2, 5, 5]);
  });

  it("stops counting work that was carried OUT to another cycle", () => {
    const carried = issue({
      id: "issue-6",
      cycleId: "cycle-2",
      estimate: 4,
      status: "todo",
      history: [
        {
          at: "2026-08-05T09:00:00.000Z",
          by: "dana",
          event: "updated",
          detail: { changed: ["cycle"], cycleFrom: "cycle-1", cycleTo: "cycle-2" },
        },
      ],
    });
    const points = cycleBurndown(cycle(), [carried], "2026-08-06");
    expect(points.map((p) => p.scope)).toEqual([4, 4, 0, 0]);
  });

  it("stops at the end date for a cycle that already ran out", () => {
    const points = cycleBurndown(cycle(), [open], "2026-09-01");
    expect(points[points.length - 1]?.date).toBe("2026-08-16");
  });

  it("draws nothing for a cycle that has not started", () => {
    expect(cycleBurndown(cycle(), [open], "2026-08-01")).toEqual([]);
  });

  it("treats a cancelled issue as settled, so the curve can still reach the floor", () => {
    const cancelled = issue({
      id: "issue-4",
      cycleId: "cycle-1",
      estimate: 5,
      status: "cancelled",
      history: [
        {
          at: "2026-08-04T10:00:00.000Z",
          by: "dana",
          event: "status_changed",
          detail: { from: "todo", to: "cancelled" },
        },
      ],
    });
    const points = cycleBurndown(cycle(), [cancelled], "2026-08-05");
    expect(points.map((p) => p.remaining)).toEqual([5, 0, 0]);
  });
});
