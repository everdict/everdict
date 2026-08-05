import {
  type CycleRecord,
  EdgeMentionSchema,
  type InitiativeRecord,
  type IssueRecord,
  MentionSchema,
  type ProjectRecord,
  type TeamRecord,
} from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { harvestCycle, harvestInitiative, harvestIssue, harvestProject, harvestTeam } from "./harvest-tracker.js";
import { nodeId } from "./ids.js";

function predicates(edges: { predicate: string; objectNodeId?: string }[]): Map<string, string | undefined> {
  return new Map(edges.map((e) => [e.predicate, e.objectNodeId]));
}

function assertValid(r: { mentions: unknown[]; edges: unknown[] }): void {
  for (const m of r.mentions) expect(MentionSchema.safeParse(m).success).toBe(true);
  for (const e of r.edges) expect(EdgeMentionSchema.safeParse(e).success).toBe(true);
}

describe("harvestIssue", () => {
  const issue: IssueRecord = {
    id: "i1",
    tenant: "acme",
    teamId: "team-eng",
    number: 12,
    identifier: "ENG-12",
    formerIdentifiers: [],
    title: "Judge misses truncated answers",
    status: "done",
    priority: "high",
    inTriage: false,
    parentId: "i0",
    cycleId: "cy1",
    projectId: "p1",
    assignee: "user-bob",
    labelIds: ["lbl-1"],
    links: [
      {
        type: "harness",
        id: "web-agent",
        version: "2.1.0",
        note: "under test",
        addedBy: "user-alice",
        addedAt: "2026-08-01T00:00:00Z",
      },
      { type: "scorecard", id: "sc-old", addedBy: "user-alice", addedAt: "2026-08-01T00:00:00Z" },
    ],
    resolution: { scorecardId: "sc-proof", by: "user-alice", at: "2026-08-02T00:00:00Z" },
    history: [],
    createdBy: "user-alice",
    createdAt: "2026-07-30T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
  };

  it("materialises the issue hub with its plan coordinates and people", () => {
    const res = harvestIssue(issue);
    expect(res.nodes[0]?.nodeId).toBe(nodeId("acme", { type: "issue", key: "i1" }));
    expect(res.nodes[0]?.label).toBe("ENG-12 · Judge misses truncated answers");
    expect(res.nodes[0]?.attrs).toMatchObject({ status: "done", identifier: "ENG-12", priority: "high" });
    const p = predicates(res.edges);
    expect(p.get("belongs_to")).toBe(nodeId("acme", { type: "team", key: "team-eng" }));
    expect(p.get("assigned_to")).toBe(nodeId("acme", { type: "user", key: "user-bob" }));
    expect(p.get("child_of")).toBe(nodeId("acme", { type: "issue", key: "i0" }));
    expect(p.get("created_by")).toBe(nodeId("acme", { type: "user", key: "user-alice" }));
    assertValid(res);
  });

  it("projects both containment coordinates (project AND cycle) as part_of", () => {
    const partOf = harvestIssue(issue)
      .edges.filter((e) => e.predicate === "part_of")
      .map((e) => e.objectNodeId);
    expect(partOf).toContain(nodeId("acme", { type: "project", key: "p1" }));
    expect(partOf).toContain(nodeId("acme", { type: "cycle", key: "cy1" }));
  });

  it("projects issue links as verified_by (version pin + note preserved) and the resolution as resolved_by", () => {
    const res = harvestIssue(issue);
    const verified = res.edges.filter((e) => e.predicate === "verified_by");
    expect(verified.map((e) => e.objectNodeId)).toEqual([
      nodeId("acme", { type: "harness", key: "web-agent", version: "2.1.0" }),
      nodeId("acme", { type: "scorecard", key: "sc-old" }),
    ]);
    expect(verified[0]?.edgeAttrs).toMatchObject({ note: "under test" });
    const resolved = res.edges.find((e) => e.predicate === "resolved_by");
    expect(resolved?.objectNodeId).toBe(nodeId("acme", { type: "scorecard", key: "sc-proof" }));
    expect(resolved?.edgeAttrs).toMatchObject({ at: "2026-08-02T00:00:00Z" });
  });

  it("does not project label ids (registry ids would render as UUID tag nodes)", () => {
    expect(harvestIssue(issue).edges.some((e) => e.predicate === "tagged_with")).toBe(false);
  });
});

describe("harvestProject", () => {
  const project: ProjectRecord = {
    id: "p1",
    tenant: "acme",
    name: "Q3 judge reliability",
    status: "in_progress",
    teamIds: ["team-eng", "team-plt"],
    memberIds: [],
    lead: "user-alice",
    health: "on_track",
    milestones: [],
    initiativeIds: ["n1"],
    history: [],
    createdBy: "user-alice",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  };

  it("materialises the project with team scoping, its goals and its lead", () => {
    const res = harvestProject(project);
    expect(res.nodes[0]?.nodeId).toBe(nodeId("acme", { type: "project", key: "p1" }));
    const teams = res.edges.filter((e) => e.predicate === "belongs_to").map((e) => e.objectNodeId);
    expect(teams).toEqual([
      nodeId("acme", { type: "team", key: "team-eng" }),
      nodeId("acme", { type: "team", key: "team-plt" }),
    ]);
    const p = predicates(res.edges);
    expect(p.get("part_of")).toBe(nodeId("acme", { type: "initiative", key: "n1" }));
    const lead = res.edges.find((e) => e.predicate === "assigned_to");
    expect(lead?.edgeAttrs).toMatchObject({ role: "lead" });
    assertValid(res);
  });
});

describe("harvestInitiative", () => {
  const initiative: InitiativeRecord = {
    id: "n1",
    tenant: "acme",
    name: "Trustworthy evals",
    status: "active",
    memberIds: [],
    resources: [],
    parentId: "n0",
    lead: "user-alice",
    history: [],
    createdBy: "user-alice",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  };

  it("materialises the goal and rolls it under its parent goal", () => {
    const res = harvestInitiative(initiative);
    expect(res.nodes[0]?.nodeId).toBe(nodeId("acme", { type: "initiative", key: "n1" }));
    const p = predicates(res.edges);
    expect(p.get("part_of")).toBe(nodeId("acme", { type: "initiative", key: "n0" }));
    assertValid(res);
  });
});

describe("harvestTeam", () => {
  const team: TeamRecord = {
    id: "team-eng",
    tenant: "acme",
    key: "ENG",
    name: "Engineering",
    isDefault: true,
    cyclesEnabled: false,
    cycleDurationWeeks: 2,
    cycleStartDay: 1,
    upcomingCycleCount: 2,
    cycleAutoClose: false,
    isPrivate: false,
    triageEnabled: false,
    issueCounter: 12,
    cycleCounter: 0,
    history: [],
    createdBy: "user-alice",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  };

  it("materialises the team named by its identifier prefix", () => {
    const res = harvestTeam(team);
    expect(res.nodes[0]?.nodeId).toBe(nodeId("acme", { type: "team", key: "team-eng" }));
    expect(res.nodes[0]?.label).toBe("ENG · Engineering");
    assertValid(res);
  });

  it("rolls a sub-team under its parent team", () => {
    const p = predicates(harvestTeam({ ...team, id: "team-rt", key: "RT", parentId: "team-eng" }).edges);
    expect(p.get("part_of")).toBe(nodeId("acme", { type: "team", key: "team-eng" }));
  });
});

describe("harvestCycle", () => {
  const cycle: CycleRecord = {
    id: "cy1",
    tenant: "acme",
    teamId: "team-eng",
    number: 7,
    startsAt: "2026-08-03",
    endsAt: "2026-08-16",
    history: [],
    createdBy: "user-alice",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  };

  it("materialises the numbered iteration under its team", () => {
    const res = harvestCycle(cycle);
    expect(res.nodes[0]?.label).toBe("Cycle 7");
    expect(res.nodes[0]?.attrs).toMatchObject({ number: 7, startsAt: "2026-08-03", endsAt: "2026-08-16" });
    const p = predicates(res.edges);
    expect(p.get("belongs_to")).toBe(nodeId("acme", { type: "team", key: "team-eng" }));
    assertValid(res);
  });

  it("prefers a themed name over the number when one is set", () => {
    expect(harvestCycle({ ...cycle, name: "Hardening" }).nodes[0]?.label).toBe("Hardening");
  });
});
