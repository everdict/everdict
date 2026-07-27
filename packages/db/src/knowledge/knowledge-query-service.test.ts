import { KnowledgeQueryService, ingestHarvest } from "@everdict/application-control";
import type { ScorecardRecord } from "@everdict/contracts";
import { harvestScorecard, nodeId } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeStore } from "./in-memory-knowledge-store.js";

// Two scorecards that share a harness — the setup that exercises multi-hop reach and reverse traversal.
function scorecard(id: string, harnessVersion: string): ScorecardRecord {
  return {
    id,
    tenant: "acme",
    dataset: { id: "web-bench", version: "1.0.0" },
    harness: { id: "web-agent", version: harnessVersion },
    status: "succeeded",
    runtime: "prod-k8s",
    orchestration: { judges: [{ id: "correctness", version: "1.0.0" }], concurrency: 4, retries: 0 },
    createdAt: "2026-07-27T00:00:00Z",
    updatedAt: "2026-07-27T01:00:00Z",
  };
}

async function seed(): Promise<InMemoryKnowledgeStore> {
  const store = new InMemoryKnowledgeStore();
  await ingestHarvest(store, harvestScorecard(scorecard("sc1", "2.1.0")));
  await ingestHarvest(store, harvestScorecard(scorecard("sc2", "2.1.0")));
  return store;
}

describe("KnowledgeQueryService — multi-hop traversal over the harvested graph", () => {
  it("returns the 1-hop related facts of a scorecard, ranked by predicate priority", async () => {
    const svc = new KnowledgeQueryService(await seed());
    const facts = await svc.relatedFacts("acme", nodeId("acme", { type: "scorecard", key: "sc1" }));
    // evaluates outranks in_workspace (priority order)
    expect(facts[0]?.predicate).toBe("evaluates");
    expect(facts.map((f) => f.predicate)).toContain("uses_dataset");
    expect(facts.find((f) => f.predicate === "evaluates")?.direction).toBe("out");
  });

  it("answers reverse queries: which scorecards evaluate a given harness", async () => {
    const svc = new KnowledgeQueryService(await seed());
    const harness = nodeId("acme", { type: "harness", key: "web-agent", version: "2.1.0" });
    const facts = await svc.relatedFacts("acme", harness, { direction: "in", predicates: ["evaluates"] });
    expect(facts.map((f) => f.nodeId).sort()).toEqual(
      [nodeId("acme", { type: "scorecard", key: "sc1" }), nodeId("acme", { type: "scorecard", key: "sc2" })].sort(),
    );
    expect(facts.every((f) => f.direction === "in")).toBe(true);
  });

  it("expands a 2-hop subgraph from a shared dataset across both scorecards to their harness", async () => {
    const svc = new KnowledgeQueryService(await seed());
    const dataset = nodeId("acme", { type: "dataset", key: "web-bench", version: "1.0.0" });
    // dataset <-(uses_dataset)- {sc1,sc2} -(evaluates)-> harness  : reachable in 2 hops
    const sub = await svc.subgraph("acme", dataset, { depth: 2, direction: "both" });
    // hop 1 reaches both scorecards (they are materialised nodes, since the scorecard harvester ran)
    const reached = new Set(sub.nodes.map((n) => n.nodeId));
    expect(reached.has(nodeId("acme", { type: "scorecard", key: "sc1" }))).toBe(true);
    expect(reached.has(nodeId("acme", { type: "scorecard", key: "sc2" }))).toBe(true);
    // hop 2 collects the evaluates edges out to the harness. The harness has no node ROW yet (its own harvester hasn't
    // run — only the scorecard harvester did), so reachability is carried by the edge, not a materialised node.
    const harness = nodeId("acme", { type: "harness", key: "web-agent", version: "2.1.0" });
    expect(sub.edges.some((e) => e.predicate === "evaluates" && e.objectNodeId === harness)).toBe(true);
    expect(reached.has(harness)).toBe(false);
  });

  it("restricts returned nodes by type without dropping traversed edges", async () => {
    const svc = new KnowledgeQueryService(await seed());
    const sc1 = nodeId("acme", { type: "scorecard", key: "sc1" });
    const sub = await svc.subgraph("acme", sc1, { depth: 1, nodeTypes: ["harness"] });
    expect(sub.nodes.every((n) => n.type === "harness")).toBe(true);
    expect(sub.edges.some((e) => e.predicate === "uses_dataset")).toBe(true); // edge kept even though dataset node filtered out
  });
});
