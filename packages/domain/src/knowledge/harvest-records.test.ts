import {
  type CommentRecord,
  EdgeMentionSchema,
  type MemberRecord,
  MentionSchema,
  type RunRecord,
  type ScheduleRecord,
} from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { harvestComment, harvestMembership, harvestRun, harvestSchedule } from "./harvest-records.js";
import { nodeId } from "./ids.js";

function predicates(edges: { predicate: string; objectNodeId?: string }[]): Map<string, string | undefined> {
  return new Map(edges.map((e) => [e.predicate, e.objectNodeId]));
}

function assertValid(r: { mentions: unknown[]; edges: unknown[] }): void {
  for (const m of r.mentions) expect(MentionSchema.safeParse(m).success).toBe(true);
  for (const e of r.edges) expect(EdgeMentionSchema.safeParse(e).success).toBe(true);
}

describe("harvestRun", () => {
  const run: RunRecord = {
    id: "r1",
    tenant: "acme",
    harness: { id: "web-agent", version: "2.1.0" },
    caseId: "case-7",
    status: "succeeded",
    parentScorecardId: "sc1",
    createdBy: "user-alice",
    runtime: "self:ho-macbook",
    createdAt: "2026-07-27T00:00:00Z",
    updatedAt: "2026-07-27T00:01:00Z",
  };

  it("materialises the run node and its foreign-key edges", () => {
    const res = harvestRun(run);
    expect(res.nodes[0]?.nodeId).toBe(nodeId("acme", { type: "run", key: "r1" }));
    const p = predicates(res.edges);
    expect(p.get("evaluates")).toBe(nodeId("acme", { type: "harness", key: "web-agent", version: "2.1.0" }));
    expect(p.get("child_of")).toBe(nodeId("acme", { type: "scorecard", key: "sc1" }));
    expect(p.get("created_by")).toBe(nodeId("acme", { type: "user", key: "user-alice" }));
    // a self:<runner> runtime becomes a placed_on edge to the runner, not runs_on
    expect(p.get("placed_on")).toBe(nodeId("acme", { type: "runner", key: "ho-macbook" }));
    expect(p.has("runs_on")).toBe(false);
    assertValid(res);
  });

  it("routes a registered runtime to runs_on", () => {
    const p = predicates(harvestRun({ ...run, runtime: "prod-k8s" }).edges);
    expect(p.get("runs_on")).toBe(nodeId("acme", { type: "runtime", key: "prod-k8s" }));
    expect(p.has("placed_on")).toBe(false);
  });
});

describe("harvestSchedule", () => {
  const sched: ScheduleRecord = {
    id: "sch1",
    tenant: "acme",
    name: "nightly regression",
    cron: "0 2 * * *",
    timezone: "Asia/Seoul",
    overlapPolicy: "skip",
    enabled: true,
    createdBy: "user-alice",
    runTemplate: {
      dataset: { id: "web-bench", version: "1.0.0" },
      harness: { id: "web-agent", version: "2.1.0" },
      judges: [{ id: "correctness", version: "1.0.0" }],
    },
    createdAt: "2026-07-27T00:00:00Z",
    updatedAt: "2026-07-27T00:00:00Z",
  };

  it("materialises the schedule node and the batch-template edges", () => {
    const res = harvestSchedule(sched);
    expect(res.nodes[0]?.type).toBe("schedule");
    const p = predicates(res.edges);
    expect(p.get("uses_dataset")).toBe(nodeId("acme", { type: "dataset", key: "web-bench", version: "1.0.0" }));
    expect(p.get("evaluates")).toBe(nodeId("acme", { type: "harness", key: "web-agent", version: "2.1.0" }));
    expect(p.get("applies_judge")).toBe(nodeId("acme", { type: "judge", key: "correctness", version: "1.0.0" }));
    assertValid(res);
  });

  it("emits pulls_from for a trace-evaluation schedule", () => {
    const p = predicates(
      harvestSchedule({
        ...sched,
        runTemplate: { pull: { source: "prod-mlflow", windowHours: 24 }, judges: [] },
      }).edges,
    );
    expect(p.get("pulls_from")).toBe(nodeId("acme", { type: "trace_source", key: "prod-mlflow" }));
    expect(p.has("evaluates")).toBe(false);
  });
});

describe("harvestComment", () => {
  const comment: CommentRecord = {
    id: "c1",
    tenant: "acme",
    resourceType: "scorecard",
    resourceId: "sc1",
    author: "user-bob",
    body: "why did this regress?",
    createdAt: "2026-07-27T00:00:00Z",
    updatedAt: "2026-07-27T00:00:00Z",
  };

  it("links a comment to the resource it discusses and its author", () => {
    const p = predicates(harvestComment(comment).edges);
    expect(p.get("discusses")).toBe(nodeId("acme", { type: "scorecard", key: "sc1" }));
    expect(p.get("created_by")).toBe(nodeId("acme", { type: "user", key: "user-bob" }));
    assertValid(harvestComment(comment));
  });

  it("links a reply to its parent comment", () => {
    const p = predicates(harvestComment({ ...comment, id: "c2", parentId: "c1" }).edges);
    expect(p.get("reply_to")).toBe(nodeId("acme", { type: "comment", key: "c1" }));
  });
});

describe("harvestMembership", () => {
  it("materialises the user node and a role-bearing member_of edge", () => {
    const m: MemberRecord = { subject: "user-alice", role: "admin", name: "Alice", addedAt: "2026-07-27T00:00:00Z" };
    const res = harvestMembership("acme", m);
    expect(res.nodes[0]?.nodeId).toBe(nodeId("acme", { type: "user", key: "user-alice" }));
    expect(res.nodes[0]?.label).toBe("Alice");
    const edge = res.edges.find((e) => e.predicate === "member_of");
    expect(edge?.objectNodeId).toBe(nodeId("acme", { type: "workspace", key: "acme" }));
    expect(edge?.edgeAttrs).toMatchObject({ role: "admin" });
    assertValid(res);
  });
});
