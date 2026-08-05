import { ingestHarvest } from "@everdict/application-control";
import type { ScorecardRecord } from "@everdict/contracts";
import { harvestScorecard, nodeId } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeStore } from "./in-memory-knowledge-store.js";

const sc: ScorecardRecord = {
  id: "sc1",
  tenant: "acme",
  dataset: { id: "web-bench", version: "1.0.0" },
  harness: { id: "web-agent", version: "2.1.0" },
  status: "succeeded",
  runtime: "prod-k8s",
  orchestration: { judges: [{ id: "correctness", version: "1.0.0" }], concurrency: 4, retries: 0 },
  createdAt: "2026-07-27T00:00:00Z",
  updatedAt: "2026-07-27T01:00:00Z",
};

describe("InMemoryKnowledgeStore — harvest → ingest → query round-trip", () => {
  it("stores a harvested scorecard and answers single-hop neighbour queries", async () => {
    const store = new InMemoryKnowledgeStore();
    await ingestHarvest(store, harvestScorecard(sc));

    const scId = nodeId("acme", { type: "scorecard", key: "sc1" });
    expect((await store.getNode("acme", scId))?.type).toBe("scorecard");

    const out = await store.outgoing("acme", scId);
    expect(out.map((e) => e.predicate).sort()).toEqual(
      ["applies_judge", "evaluates", "in_workspace", "runs_on", "uses_dataset"].sort(),
    );
    expect((await store.outgoing("acme", scId, "evaluates"))[0]?.objectNodeId).toBe(
      nodeId("acme", { type: "harness", key: "web-agent", version: "2.1.0" }),
    );

    // reverse traversal: which scorecards evaluate this harness?
    const harnessId = nodeId("acme", { type: "harness", key: "web-agent", version: "2.1.0" });
    const incoming = await store.incoming("acme", harnessId, "evaluates");
    expect(incoming[0]?.subjectNodeId).toBe(scId);

    // per-source audit trail
    expect((await store.listMentions("acme", "scorecard", "sc1")).length).toBeGreaterThan(0);
  });

  it("is idempotent — re-ingesting the same harvest does not duplicate edges", async () => {
    const store = new InMemoryKnowledgeStore();
    await ingestHarvest(store, harvestScorecard(sc));
    await ingestHarvest(store, harvestScorecard(sc));
    const scId = nodeId("acme", { type: "scorecard", key: "sc1" });
    const out = await store.outgoing("acme", scId, "evaluates");
    expect(out).toHaveLength(1);
  });

  it("scopes reads by tenant", async () => {
    const store = new InMemoryKnowledgeStore();
    await ingestHarvest(store, harvestScorecard(sc));
    const scId = nodeId("acme", { type: "scorecard", key: "sc1" });
    expect(await store.getNode("other", scId)).toBeUndefined();
    expect(await store.outgoing("other", scId)).toHaveLength(0);
  });

  it("retracts node rows by type while the mention/edge spine stays (the reindex prune)", async () => {
    const store = new InMemoryKnowledgeStore();
    await ingestHarvest(store, harvestScorecard(sc));
    const scId = nodeId("acme", { type: "scorecard", key: "sc1" });

    expect(await store.listNodeIds("acme", ["scorecard", "run"])).toEqual([scId]);
    expect(await store.listNodeIds("other", ["scorecard"])).toHaveLength(0); // tenant-scoped
    expect(await store.listNodeIds("acme", ["harness"])).toHaveLength(0); // type-scoped

    await store.deleteNodes("other", [scId]); // wrong tenant — a cross-tenant delete must be a no-op
    expect(await store.getNode("acme", scId)).toBeDefined();

    await store.deleteNodes("acme", [scId]);
    expect(await store.getNode("acme", scId)).toBeUndefined();
    // the audit spine survives the retraction
    expect((await store.listMentions("acme", "scorecard", "sc1")).length).toBeGreaterThan(0);
    expect((await store.outgoing("acme", scId)).length).toBeGreaterThan(0);
  });
});
