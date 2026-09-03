import {
  EdgeMentionSchema,
  type InitiativeRecord,
  type IssueRecord,
  MentionSchema,
  type ProjectRecord,
} from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { harvestInitiative, harvestIssue, harvestProject } from "./harvest-tracker.js";
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
    number: 12,
    identifier: "ENG-12",
    formerIdentifiers: [],
    title: "Judge misses truncated answers",
    status: "done",
    priority: "high",
    parentId: "i0",
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
    expect(p.get("assigned_to")).toBe(nodeId("acme", { type: "user", key: "user-bob" }));
    expect(p.get("child_of")).toBe(nodeId("acme", { type: "issue", key: "i0" }));
    expect(p.get("created_by")).toBe(nodeId("acme", { type: "user", key: "user-alice" }));
    assertValid(res);
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

  it("names the project and the goal it serves", () => {
    const res = harvestProject(project);
    expect(res.nodes[0]?.label).toBe("Q3 judge reliability");
    const p = predicates(res.edges);
    expect(p.get("part_of")).toBe(nodeId("acme", { type: "initiative", key: "n1" }));
    expect(p.get("in_workspace")).toBe(nodeId("acme", { type: "workspace", key: "acme" }));
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
