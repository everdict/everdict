import { KnowledgeEntryService, KnowledgeService } from "@everdict/application-control";
import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { Dataset, NodeRef, ScorecardRecord } from "@everdict/contracts";
import {
  InMemoryCommentStore,
  InMemoryKnowledgeEntryStore,
  InMemoryKnowledgeStore,
  InMemoryRunStore,
  InMemoryScorecardStore,
} from "@everdict/db";
import { harvestScorecard, nodeId } from "@everdict/domain";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { KnowledgeExtractionService } from "../../core/knowledge/knowledge-extraction-service.js";
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
  const knowledgeEntryStore = new InMemoryKnowledgeEntryStore();
  // Fake registry-latest: the harness family moved on to 2.3.0 (so a 2.1.0-pinned ref reads superseded).
  const latestVersionOf = async (_tenant: string, ref: NodeRef) =>
    ref.type === "harness" && ref.key === "web-agent" ? "2.3.0" : undefined;
  const knowledgeEntryService = new KnowledgeEntryService({ store: knowledgeEntryStore, latestVersionOf });
  // 추출 라우트: 코멘트 1 스레드 + 캔드 완성(candidate 1개) — 라우트/게이트/왕복 검증용 (모델 호출 없음)
  const comments = new InMemoryCommentStore();
  await comments.add({
    id: "root",
    tenant: "acme",
    resourceType: "scorecard",
    resourceId: "sc1",
    author: "user-alice",
    body: "login flakiness discussion",
    createdAt: "2026-07-28T00:00:00Z",
    updatedAt: "2026-07-28T00:00:00Z",
  });
  const knowledgeExtraction = new KnowledgeExtractionService({
    models: { get: async () => ({ id: "m", version: "1", provider: "anthropic", model: "x" }) } as never,
    scopedSecretsFor: async () => ({ workspace: {}, user: {} }),
    entries: knowledgeEntryService,
    comments,
    completionFor: async () => async () =>
      JSON.stringify([
        { kind: "finding", title: "Login cases are flaky on k8s", body: "…", refs: [], confidence: 0.7 },
      ]),
  });
  return buildServer({
    service,
    knowledgeService: new KnowledgeService({
      store,
      reindexSources: { scorecards, datasets },
      contextSources: { knowledgeEntries: knowledgeEntryStore, latestVersionOf },
    }),
    knowledgeEntryService,
    knowledgeExtraction,
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

describe("knowledge entries — reified claims", () => {
  const entryPayload = {
    kind: "finding",
    title: "login cases flaky on k8s",
    body: "variance only on the k8s runtime",
    refs: [{ type: "harness", key: "web-agent", version: "2.1.0" }],
    evidence: [{ type: "scorecard", key: "sc1" }],
    visibility: "workspace",
  };

  it("404s when the entry service is not configured", async () => {
    const res = await (await build(false)).inject({ method: "GET", url: "/knowledge/entries", headers: H });
    expect(res.statusCode).toBe(404);
  });

  it("creates an entry, lists it coverage-decorated (interval ends at 2.1.0, present 2.3.0 → behind)", async () => {
    const app = await build(true);
    const post = await app.inject({ method: "POST", url: "/knowledge/entries", headers: H, payload: entryPayload });
    expect(post.statusCode).toBe(201);
    const created = post.json() as { id: string; status: string };
    expect(created.status).toBe("active");

    const list = await app.inject({ method: "GET", url: "/knowledge/entries", headers: H });
    expect(list.statusCode).toBe(200);
    const entries = list.json() as Array<{ id: string; coverage?: { state: string } }>;
    expect(entries[0]?.id).toBe(created.id);
    expect(entries[0]?.coverage?.state).toBe("behind");
  });

  it("400s an unknown kind (closed vocabulary, no fallback)", async () => {
    const res = await (await build(true)).inject({
      method: "POST",
      url: "/knowledge/entries",
      headers: H,
      payload: { ...entryPayload, kind: "insight" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("verify stamps verifiedAt without touching updatedAt; PATCH edits; DELETE removes", async () => {
    const app = await build(true);
    const created = (
      await app.inject({ method: "POST", url: "/knowledge/entries", headers: H, payload: entryPayload })
    ).json() as { id: string; updatedAt: string };

    const verified = await app.inject({
      method: "POST",
      url: `/knowledge/entries/${created.id}/verify`,
      headers: H,
    });
    expect(verified.statusCode).toBe(200);
    const vBody = verified.json() as { verifiedAt?: string; updatedAt: string };
    expect(vBody.verifiedAt).toBeDefined();
    expect(vBody.updatedAt).toBe(created.updatedAt);

    const patched = await app.inject({
      method: "PATCH",
      url: `/knowledge/entries/${created.id}`,
      headers: H,
      payload: { status: "deprecated" },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { status: string }).status).toBe("deprecated");

    const removed = await app.inject({ method: "DELETE", url: `/knowledge/entries/${created.id}`, headers: H });
    expect(removed.statusCode).toBe(204);
    const gone = await app.inject({ method: "GET", url: `/knowledge/entries/${created.id}`, headers: H });
    expect(gone.statusCode).toBe(404);
  });

  it("assembles task context: anchors' facts + the entries about the anchor family (version-agnostic match)", async () => {
    const app = await build(true);
    await app.inject({ method: "POST", url: "/knowledge/entries", headers: H, payload: entryPayload });

    const res = await app.inject({
      method: "POST",
      url: "/knowledge/context",
      headers: H,
      // The task anchors a NEWER harness version — the 2.1.0-pinned claim must still surface (family match).
      payload: { refs: [{ type: "harness", key: "web-agent", version: "2.3.0" }] },
    });
    expect(res.statusCode).toBe(200);
    const ctx = res.json() as {
      anchors: Array<{ nodeId: string; facts: unknown[] }>;
      knowledge: Array<{ title: string; relation?: string; coverage?: { state: string } }>;
      skills: unknown[];
    };
    expect(ctx.anchors[0]?.nodeId).toBe(nodeId("acme", { type: "harness", key: "web-agent", version: "2.3.0" }));
    expect(ctx.knowledge[0]?.title).toBe(entryPayload.title);
    expect(ctx.knowledge[0]?.coverage?.state).toBe("behind");
    expect(ctx.knowledge[0]?.relation).toBe("earlier"); // pinned at 2.1.0, anchored at 2.3.0
  });

  it("400s an empty context anchor list", async () => {
    const res = await (await build(true)).inject({
      method: "POST",
      url: "/knowledge/context",
      headers: H,
      payload: { refs: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("knowledge extraction — thread → proposed → approve/reject", () => {
  it("extracts proposals from a thread, review-approves one (authorship transfer), and rejects on re-extract dupes", async () => {
    const app = await build(true);
    const extracted = await app.inject({
      method: "POST",
      url: "/knowledge/extract",
      headers: H,
      payload: { source: { kind: "comment", id: "root" }, model: "m" },
    });
    expect(extracted.statusCode).toBe(200);
    const { proposals } = extracted.json() as { proposals: Array<{ id: string; status: string; createdBy: string }> };
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.status).toBe("proposed");
    expect(proposals[0]?.createdBy).toBe("everdict:extractor");
    const id = proposals[0]?.id ?? "";

    // re-extract: the same claim is skipped, not duplicated
    const again = await app.inject({
      method: "POST",
      url: "/knowledge/extract",
      headers: H,
      payload: { source: { kind: "comment", id: "root" }, model: "m" },
    });
    expect((again.json() as { skippedDuplicates: number }).skippedDuplicates).toBe(1);

    // approve → active + the approver owns it
    const approved = await app.inject({ method: "POST", url: `/knowledge/entries/${id}/approve`, headers: H });
    expect(approved.statusCode).toBe(200);
    const body = approved.json() as { status: string; createdBy: string; extraction?: { sourceId: string } };
    expect(body.status).toBe("active");
    expect(body.createdBy).not.toBe("everdict:extractor");
    expect(body.extraction?.sourceId).toBe("root"); // provenance survives approval

    // a second approve is a 409 (already active), reject likewise
    expect((await app.inject({ method: "POST", url: `/knowledge/entries/${id}/approve`, headers: H })).statusCode).toBe(
      409,
    );
    expect((await app.inject({ method: "POST", url: `/knowledge/entries/${id}/reject`, headers: H })).statusCode).toBe(
      409,
    );
  });

  it("reject deletes a proposal (204 → 404)", async () => {
    const app = await build(true);
    const { proposals } = (
      await app.inject({
        method: "POST",
        url: "/knowledge/extract",
        headers: H,
        payload: { source: { kind: "comment", id: "root" }, model: "m" },
      })
    ).json() as { proposals: Array<{ id: string }> };
    const id = proposals[0]?.id ?? "";
    expect((await app.inject({ method: "POST", url: `/knowledge/entries/${id}/reject`, headers: H })).statusCode).toBe(
      204,
    );
    expect((await app.inject({ method: "GET", url: `/knowledge/entries/${id}`, headers: H })).statusCode).toBe(404);
  });

  it("400s an unsupported source kind and 404s when extraction is not configured", async () => {
    const bad = await (await build(true)).inject({
      method: "POST",
      url: "/knowledge/extract",
      headers: H,
      payload: { source: { kind: "agent_session", id: "s1" }, model: "m" },
    });
    expect(bad.statusCode).toBe(400);
    const off = await (await build(false)).inject({
      method: "POST",
      url: "/knowledge/extract",
      headers: H,
      payload: { source: { kind: "comment", id: "root" }, model: "m" },
    });
    expect(off.statusCode).toBe(404);
  });
});
