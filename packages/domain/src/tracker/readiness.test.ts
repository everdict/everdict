import type { IssueRecord, IssueStatus, ProjectRecord, ProjectStatus } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { initiativeProgress, initiativeReadiness, projectRollup } from "./readiness.js";

const NOW = "2026-07-31T00:00:00.000Z";
const INITIATIVE = "ini-ship";

function issue(id: string, status: IssueStatus, scorecardId?: string): IssueRecord {
  return {
    id,
    tenant: "acme",
    number: 1,
    identifier: `ENG-${id}`,
    formerIdentifiers: [],
    title: `issue ${id}`,
    status,
    priority: "none",
    labelIds: [],
    links: [],
    ...(status === "done" || status === "regressed"
      ? { resolution: { ...(scorecardId !== undefined ? { scorecardId } : {}), by: "dana", at: NOW } }
      : {}),
    history: [],
    createdBy: "dana",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function project(id: string, status: ProjectStatus, initiativeIds: string[] = [INITIATIVE]): ProjectRecord {
  return {
    id,
    tenant: "acme",
    name: `project ${id}`,
    status,
    initiativeIds,
    memberIds: [],
    milestones: [],
    history: [],
    createdBy: "dana",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("projectRollup", () => {
  it("counts open work, and separates 'resolved' from 'resolved with evidence'", () => {
    const rollup = projectRollup([
      issue("a", "todo"),
      issue("b", "in_progress"),
      issue("c", "done", "sc-1"),
      issue("d", "done"),
      issue("e", "cancelled"),
    ]);
    expect(rollup).toMatchObject({ total: 5, open: 2, done: 2, cancelled: 1, evaluated: 1, ready: false });
    expect(rollup.byStatus.todo).toBe(1);
    expect(rollup.byStatus.backlog).toBe(0); // every status key present, so consumers never branch on undefined
  });

  it("counts a regressed issue as OPEN — a resolution that stopped holding is unfinished work", () => {
    const rollup = projectRollup([issue("a", "done", "sc-1"), issue("b", "regressed", "sc-2")]);
    expect(rollup.open).toBe(1);
    expect(rollup.ready).toBe(false);
  });

  it("is ready when nothing is open", () => {
    expect(projectRollup([issue("a", "done", "sc-1"), issue("b", "cancelled")]).ready).toBe(true);
    expect(projectRollup([]).ready).toBe(true);
  });
});

describe("initiativeReadiness", () => {
  it("blocks the release when a COMPLETED project holds a regressed issue", () => {
    const readiness = initiativeReadiness(
      INITIATIVE,
      [project("p1", "completed"), project("p2", "in_progress")],
      new Map([
        ["p1", [issue("a", "regressed", "sc-1")]],
        ["p2", [issue("b", "done", "sc-2")]],
      ]),
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.openIssues).toBe(1);
    expect(readiness.blockers).toEqual([
      { projectId: "p1", issueId: "a", identifier: "ENG-a", title: "issue a", status: "regressed" },
    ]);
  });

  it("ignores a cancelled project's work — it is off the release, not pending", () => {
    const readiness = initiativeReadiness(
      INITIATIVE,
      [project("p1", "cancelled"), project("p2", "in_progress")],
      new Map([
        ["p1", [issue("a", "todo")]],
        ["p2", [issue("b", "done", "sc-2")]],
      ]),
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.openIssues).toBe(0);
    expect(readiness.totalIssues).toBe(1);
    expect(readiness.projects).toHaveLength(2); // still summarized, just not counted
  });

  it("leads the blocker list with regressions", () => {
    const readiness = initiativeReadiness(
      INITIATIVE,
      [project("p1", "in_progress")],
      new Map([["p1", [issue("a", "todo"), issue("b", "regressed", "sc-1")]]]),
    );
    expect(readiness.blockers.map((b) => b.issueId)).toEqual(["b", "a"]);
  });

  it("counts a project claimed by a SUB-initiative, and says which one it came up through", () => {
    // Given: the goal's own project is settled, but a sub-initiative's project still has open work.
    const readiness = initiativeReadiness(
      INITIATIVE,
      [project("p1", "in_progress"), project("p2", "in_progress", ["ini-sub"])],
      new Map([
        ["p1", [issue("a", "done", "sc-1")]],
        ["p2", [issue("b", "todo")]],
      ]),
    );
    // Then: nesting cannot hide work from the goal, and the summary points at the descendant.
    expect(readiness.ready).toBe(false);
    expect(readiness.openIssues).toBe(1);
    expect(readiness.projects.find((p) => p.id === "p1")?.viaInitiativeId).toBeUndefined();
    expect(readiness.projects.find((p) => p.id === "p2")?.viaInitiativeId).toBe("ini-sub");
  });

  it("is ready when every project's issues are settled", () => {
    const readiness = initiativeReadiness(
      INITIATIVE,
      [project("p1", "completed")],
      new Map([["p1", [issue("a", "done", "sc-1"), issue("b", "cancelled")]]]),
    );
    expect(readiness).toMatchObject({ ready: true, openIssues: 0, totalIssues: 2, blockers: [] });
  });
});

// The LIST's arithmetic. It must answer exactly what `initiativeReadiness` answers for the same data — a row
// that disagrees with the page it links to is worse than no row — so every case here is stated against the
// detail's rules: cancelled projects are off the goal, descendants roll up, and a project with no issues yet
// contributes nothing rather than a zero.
describe("initiativeProgress — the same numbers, from an aggregate", () => {
  it("rolls a descendant's projects up into the parent and skips cancelled work", () => {
    const initiatives = [{ id: INITIATIVE }, { id: "ini-sub", parentId: INITIATIVE }];
    const projects = [
      project("p1", "in_progress"),
      project("p2", "in_progress", ["ini-sub"]),
      project("p3", "cancelled"),
    ];
    const counts = new Map([
      ["p1", { open: 1, total: 3 }],
      ["p2", { open: 2, total: 2 }],
      ["p3", { open: 9, total: 9 }],
    ]);

    const progress = initiativeProgress(initiatives, projects, counts);
    // The parent counts both live projects; the cancelled one is summarized (projects: 3) but never counted.
    expect(progress.get(INITIATIVE)).toEqual({ open: 3, total: 5, projects: 3 });
    // The child answers for its own project only.
    expect(progress.get("ini-sub")).toEqual({ open: 2, total: 2, projects: 1 });
  });

  it("agrees with the detail's fan-out on the same data", () => {
    const projects = [project("p1", "in_progress"), project("p2", "cancelled")];
    const issuesByProject = new Map([
      ["p1", [issue("a", "regressed"), issue("b", "done", "sc-1")]],
      ["p2", [issue("c", "todo")]],
    ]);
    const readiness = initiativeReadiness(INITIATIVE, projects, issuesByProject);
    const counts = new Map(
      [...issuesByProject].map(([id, issues]) => {
        const rollup = projectRollup(issues);
        return [id, { open: rollup.open, total: rollup.total }] as const;
      }),
    );

    const progress = initiativeProgress([{ id: INITIATIVE }], projects, counts);
    expect(progress.get(INITIATIVE)).toEqual({
      open: readiness.openIssues,
      total: readiness.totalIssues,
      projects: readiness.projects.length,
    });
  });

  it("reports a goal with nothing under it as empty rather than absent", () => {
    const progress = initiativeProgress([{ id: INITIATIVE }], [], new Map());
    expect(progress.get(INITIATIVE)).toEqual({ open: 0, total: 0, projects: 0 });
  });
});
