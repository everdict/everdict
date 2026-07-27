import { KnowledgeService } from "@everdict/application-control";
import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { Dataset, ScorecardRecord } from "@everdict/contracts";
import { InMemoryKnowledgeStore, InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { harvestScorecard, nodeId } from "@everdict/domain";
import { InMemoryDatasetRegistry } from "@everdict/registry";
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
  const datasets = new InMemoryDatasetRegistry();
  await datasets.register("acme", DATASET, "user-alice");
  return buildServer({
    service,
    knowledgeService: new KnowledgeService({ store, reindexSources: { scorecards, datasets } }),
  });
}

const DATASET: Dataset = {
  id: "web-bench",
  version: "1.0.0",
  cases: [{ id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", timeoutSec: 60, tags: [], graders: [] }],
  tags: ["web"],
};
const DATASET_NODE = nodeId("acme", { type: "dataset", key: "web-bench", version: "1.0.0" });

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

  it("reindex materialises registry nodes — the dataset node the scorecard edge pointed at", async () => {
    const app = await build(true);
    // Before reindex, only the scorecard's dataset EDGE exists; the dataset NODE row is not yet materialised.
    const before = await app.inject({
      method: "GET",
      url: `/knowledge/node?id=${encodeURIComponent(DATASET_NODE)}`,
      headers: H,
    });
    expect(before.statusCode).toBe(404);
    await app.inject({ method: "POST", url: "/knowledge/reindex", headers: H });
    const after = await app.inject({
      method: "GET",
      url: `/knowledge/node?id=${encodeURIComponent(DATASET_NODE)}`,
      headers: H,
    });
    expect(after.statusCode).toBe(200);
    expect((after.json() as { type: string }).type).toBe("dataset");
  });

  it("returns the whole workspace graph rooted at the workspace hub node", async () => {
    const res = await (await build(true)).inject({ method: "GET", url: "/knowledge/graph", headers: H });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      root: string;
      nodes: Array<{ nodeId: string; type: string }>;
      edges: Array<{ predicate: string }>;
      stats: { totalNodes: number; totalEdges: number; nodesByType: Record<string, number> };
    };
    // rooted at the workspace hub node — every harvested entity carries an in_workspace edge to it
    expect(body.root).toBe(nodeId("acme", { type: "workspace", key: "acme" }));
    // the scorecard is reached (in_workspace incoming), and its eval edges are pulled in at depth 2
    expect(body.nodes.some((n) => n.nodeId === SC_NODE)).toBe(true);
    expect(body.stats.nodesByType.scorecard).toBe(1);
    expect(body.stats.totalNodes).toBe(body.nodes.length);
    expect(body.edges.some((e) => e.predicate === "evaluates")).toBe(true);
  });

  it("400s a graph depth below 1", async () => {
    const res = await (await build(true)).inject({ method: "GET", url: "/knowledge/graph?depth=0", headers: H });
    expect(res.statusCode).toBe(400);
  });

  it("404s the graph when the knowledge service is not configured", async () => {
    const res = await (await build(false)).inject({ method: "GET", url: "/knowledge/graph", headers: H });
    expect(res.statusCode).toBe(404);
  });

  it("annotate attaches an authored note readable via /knowledge/annotations", async () => {
    const app = await build(true);
    const post = await app.inject({
      method: "POST",
      url: "/knowledge/annotate",
      headers: H,
      payload: { node: { type: "scorecard", key: "sc1" }, note: "flaky on network cases" },
    });
    expect(post.statusCode).toBe(201);
    const notes = await app.inject({
      method: "GET",
      url: `/knowledge/annotations?id=${encodeURIComponent(SC_NODE)}`,
      headers: H,
    });
    expect(notes.statusCode).toBe(200);
    const body = notes.json() as { notes: Array<{ evidenceQuote?: string; origin: string }> };
    expect(body.notes[0]?.evidenceQuote).toBe("flaky on network cases");
    expect(body.notes[0]?.origin).toBe("authored");
  });

  it("400s an empty annotate note", async () => {
    const res = await (await build(true)).inject({
      method: "POST",
      url: "/knowledge/annotate",
      headers: H,
      payload: { node: { type: "scorecard", key: "sc1" }, note: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("relate asserts an authored edge readable via /knowledge/related", async () => {
    const app = await build(true);
    const post = await app.inject({
      method: "POST",
      url: "/knowledge/relate",
      headers: H,
      payload: {
        subject: { type: "scorecard", key: "sc1" },
        predicate: "compared_to",
        object: { type: "scorecard", key: "sc2" },
        note: "same dataset, newer harness",
      },
    });
    expect(post.statusCode).toBe(201);
    const related = await app.inject({
      method: "GET",
      url: `/knowledge/related?id=${encodeURIComponent(SC_NODE)}&direction=out&predicates=compared_to`,
      headers: H,
    });
    const facts = (related.json() as { facts: Array<{ predicate: string; nodeId: string }> }).facts;
    expect(facts.find((f) => f.predicate === "compared_to")?.nodeId).toBe(
      nodeId("acme", { type: "scorecard", key: "sc2" }),
    );
  });

  it("400s relating a node to itself", async () => {
    const res = await (await build(true)).inject({
      method: "POST",
      url: "/knowledge/relate",
      headers: H,
      payload: {
        subject: { type: "scorecard", key: "sc1" },
        predicate: "compared_to",
        object: { type: "scorecard", key: "sc1" },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
