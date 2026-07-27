import { KnowledgeService } from "@everdict/application-control";
import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { ScorecardRecord } from "@everdict/contracts";
import { InMemoryKnowledgeStore, InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { harvestScorecard, nodeId } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in knowledge tests");
  },
};

const SCORECARD: ScorecardRecord = {
  id: "sc1",
  tenant: "acme",
  dataset: { id: "web-bench", version: "1.0.0" },
  harness: { id: "web-agent", version: "2.1.0" },
  status: "succeeded",
  orchestration: { judges: [{ id: "correctness", version: "1.0.0" }], concurrency: 4, retries: 0 },
  createdAt: "2026-07-27T00:00:00Z",
  updatedAt: "2026-07-27T01:00:00Z",
};

const H = { "x-everdict-tenant": "acme" };
const SC_NODE = nodeId("acme", { type: "scorecard", key: "sc1" });
const HARNESS_NODE = nodeId("acme", { type: "harness", key: "web-agent", version: "2.1.0" });

async function build(withKnowledge: boolean) {
  const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
  if (!withKnowledge) return buildServer({ service });

  const store = new InMemoryKnowledgeStore();
  const h = harvestScorecard(SCORECARD);
  await store.putNodes(h.nodes);
  await store.putMentions(h.mentions);
  await store.putEdges(h.edges);
  const scorecards = new InMemoryScorecardStore();
  await scorecards.create(SCORECARD);
  return buildServer({ service, knowledgeService: new KnowledgeService({ store, reindexSources: { scorecards } }) });
}

describe("knowledge routes", () => {
  it("returns 404 when the knowledge service is not configured", async () => {
    const res = await (await build(false)).inject({ method: "GET", url: `/knowledge/node?id=${SC_NODE}`, headers: H });
    expect(res.statusCode).toBe(404);
  });

  it("400s when the node id query param is missing", async () => {
    const res = await (await build(true)).inject({ method: "GET", url: "/knowledge/node", headers: H });
    expect(res.statusCode).toBe(400);
  });

  it("gets a harvested node by id, and 404s an unknown id", async () => {
    const app = await build(true);
    const ok = await app.inject({
      method: "GET",
      url: `/knowledge/node?id=${encodeURIComponent(SC_NODE)}`,
      headers: H,
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { type: string }).type).toBe("scorecard");
    const miss = await app.inject({ method: "GET", url: "/knowledge/node?id=scorecard:acme:nope", headers: H });
    expect(miss.statusCode).toBe(404);
  });

  it("returns ranked related facts, evaluates outranking in_workspace", async () => {
    const res = await (await build(true)).inject({
      method: "GET",
      url: `/knowledge/related?id=${encodeURIComponent(SC_NODE)}&direction=out`,
      headers: H,
    });
    expect(res.statusCode).toBe(200);
    const facts = (res.json() as { facts: Array<{ predicate: string; nodeId: string }> }).facts;
    expect(facts[0]?.predicate).toBe("evaluates");
    expect(facts.find((f) => f.predicate === "evaluates")?.nodeId).toBe(HARNESS_NODE);
  });

  it("400s an invalid predicate filter (closed vocabulary)", async () => {
    const res = await (await build(true)).inject({
      method: "GET",
      url: `/knowledge/related?id=${encodeURIComponent(SC_NODE)}&predicates=not_a_predicate`,
      headers: H,
    });
    expect(res.statusCode).toBe(400);
  });

  it("expands a subgraph and reindexes from the record stores", async () => {
    const app = await build(true);
    const sub = await app.inject({
      method: "GET",
      url: `/knowledge/subgraph?id=${encodeURIComponent(SC_NODE)}&depth=1`,
      headers: H,
    });
    expect(sub.statusCode).toBe(200);
    expect((sub.json() as { edges: unknown[] }).edges.length).toBeGreaterThan(0);

    const reindex = await app.inject({ method: "POST", url: "/knowledge/reindex", headers: H });
    expect(reindex.statusCode).toBe(200);
    expect((reindex.json() as { scanned: number }).scanned).toBeGreaterThanOrEqual(1);
  });
});
