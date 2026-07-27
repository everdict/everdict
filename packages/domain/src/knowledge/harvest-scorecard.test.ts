import { EdgeMentionSchema, MentionSchema, type ScorecardRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { harvestScorecard } from "./harvest-scorecard.js";
import { nodeId } from "./ids.js";

const base: ScorecardRecord = {
  id: "sc1",
  tenant: "acme",
  dataset: { id: "web-bench", version: "1.0.0" },
  harness: { id: "web-agent", version: "2.1.0" },
  status: "succeeded",
  createdBy: "user-alice",
  runtime: "prod-k8s",
  origin: { source: "schedule", scheduleId: "sched-7" },
  orchestration: { judges: [{ id: "correctness", version: "1.0.0" }], concurrency: 4, retries: 0 },
  summary: [{ metric: "answer_match", count: 10, mean: 0.8, passRate: 0.8 }],
  createdAt: "2026-07-27T00:00:00Z",
  updatedAt: "2026-07-27T01:00:00Z",
};

describe("harvestScorecard — a scorecard record projected into the graph", () => {
  it("emits the self node and every foreign-key edge with the right endpoints", () => {
    const { nodes, edges, mentions } = harvestScorecard(base);

    // the source is its own node
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.nodeId).toBe("scorecard:acme:sc1");
    expect(nodes[0]?.type).toBe("scorecard");

    const byPredicate = new Map(edges.map((e) => [e.predicate, e]));
    expect(byPredicate.get("in_workspace")?.objectNodeId).toBe(nodeId("acme", { type: "workspace", key: "acme" }));
    expect(byPredicate.get("created_by")?.objectNodeId).toBe(nodeId("acme", { type: "user", key: "user-alice" }));
    expect(byPredicate.get("evaluates")?.objectNodeId).toBe(
      nodeId("acme", { type: "harness", key: "web-agent", version: "2.1.0" }),
    );
    expect(byPredicate.get("uses_dataset")?.objectNodeId).toBe(
      nodeId("acme", { type: "dataset", key: "web-bench", version: "1.0.0" }),
    );
    expect(byPredicate.get("applies_judge")?.objectNodeId).toBe(
      nodeId("acme", { type: "judge", key: "correctness", version: "1.0.0" }),
    );
    expect(byPredicate.get("runs_on")?.objectNodeId).toBe(nodeId("acme", { type: "runtime", key: "prod-k8s" }));
    expect(byPredicate.get("fired_by")?.objectNodeId).toBe(nodeId("acme", { type: "schedule", key: "sched-7" }));
    // the metric edge carries the aggregate onto edgeAttrs
    expect(byPredicate.get("measures")?.edgeAttrs).toMatchObject({ mean: 0.8, passRate: 0.8, count: 10 });

    // every emitted row is a valid contract instance (harvest passes the audit-lock + XOR superRefines)
    for (const m of mentions) expect(MentionSchema.safeParse(m).success).toBe(true);
    for (const e of edges) expect(EdgeMentionSchema.safeParse(e).success).toBe(true);
    // all harvested edges are exact
    expect(edges.every((e) => e.origin === "harvest" && e.confidence === 1 && e.resolution === "resolved")).toBe(true);
  });

  it("is idempotent — re-harvesting yields identical ids", () => {
    const a = harvestScorecard(base);
    const b = harvestScorecard(base);
    expect(a.edges.map((e) => e.id)).toEqual(b.edges.map((e) => e.id));
    expect(a.mentions.map((m) => m.id)).toEqual(b.mentions.map((m) => m.id));
  });

  it("skips the harness/dataset edges for a trace-evaluation scorecard (sentinel refs)", () => {
    const traceEval: ScorecardRecord = {
      ...base,
      dataset: { id: "_traces", version: "0" },
      harness: { id: "_traces", version: "0" },
    };
    const preds = new Set(harvestScorecard(traceEval).edges.map((e) => e.predicate));
    expect(preds.has("evaluates")).toBe(false);
    expect(preds.has("uses_dataset")).toBe(false);
    expect(preds.has("in_workspace")).toBe(true); // non-eval edges still emitted
  });
});
