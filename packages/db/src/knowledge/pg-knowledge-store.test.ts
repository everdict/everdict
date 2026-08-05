import type { EdgeMention, KnowledgeNode } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgKnowledgeStore } from "./pg-knowledge-store.js";

function fakeClient(handler: (text: string, params?: unknown[]) => { rows: unknown[] }): {
  client: SqlClient;
  calls: Array<{ text: string; params?: unknown[] }>;
} {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client: SqlClient = {
    async query(text, params) {
      calls.push({ text, params });
      return handler(text, params) as { rows: never[] };
    },
  };
  return { client, calls };
}

const node: KnowledgeNode = {
  nodeId: "scorecard:acme:sc1",
  tenant: "acme",
  type: "scorecard",
  key: "sc1",
  label: "web-bench × web-agent",
  attrs: { status: "succeeded" },
  resolution: "resolved",
  evidenceCount: 1,
  firstObservedAt: "2026-07-27T00:00:00Z",
  lastObservedAt: "2026-07-27T01:00:00Z",
  createdAt: "2026-07-27T00:00:00Z",
  updatedAt: "2026-07-27T01:00:00Z",
};

const edge: EdgeMention = {
  id: "edg_1",
  tenant: "acme",
  predicate: "evaluates",
  subjectNodeId: "scorecard:acme:sc1",
  objectNodeId: "harness:acme:web-agent@2.1.0",
  objectTypeHint: "harness",
  edgeAttrs: {},
  polarity: "affirmed",
  sourceKind: "scorecard",
  sourceId: "sc1",
  origin: "harvest",
  extractor: "scorecard_harvester_v1",
  confidence: 1,
  evidencePath: "harness",
  resolution: "resolved",
  createdAt: "2026-07-27T00:00:00Z",
};

describe("PgKnowledgeStore", () => {
  it("upserts a node by node_id (ON CONFLICT DO UPDATE) with jsonb attrs stringified", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgKnowledgeStore(client).putNodes([node]);
    expect(calls[0]?.text).toContain("INSERT INTO everdict_knowledge_nodes");
    expect(calls[0]?.text).toContain("ON CONFLICT (node_id) DO UPDATE");
    expect(calls[0]?.params?.[0]).toBe("scorecard:acme:sc1");
    expect(calls[0]?.params?.[6]).toBe(JSON.stringify({ status: "succeeded" }));
  });

  it("appends an edge idempotently (ON CONFLICT DO NOTHING)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgKnowledgeStore(client).putEdges([edge]);
    expect(calls[0]?.text).toContain("INSERT INTO everdict_knowledge_edges");
    expect(calls[0]?.text).toContain("ON CONFLICT (id) DO NOTHING");
  });

  it("filters outgoing by predicate when given, and maps rows back through the schema", async () => {
    const row = {
      id: "edg_1",
      tenant: "acme",
      predicate: "evaluates",
      subject_mention_id: null,
      subject_node_id: "scorecard:acme:sc1",
      subject_type_hint: null,
      object_mention_id: null,
      object_node_id: "harness:acme:web-agent@2.1.0",
      object_type_hint: "harness",
      edge_attrs: {},
      polarity: "affirmed",
      source_kind: "scorecard",
      source_id: "sc1",
      origin: "harvest",
      extractor: "scorecard_harvester_v1",
      confidence: 1,
      evidence_path: "harness",
      evidence_quote: null,
      evidence_offset_start: null,
      evidence_offset_end: null,
      evidence_lang: null,
      resolution: "resolved",
      created_at: "2026-07-27T00:00:00Z",
    };
    const { client, calls } = fakeClient(() => ({ rows: [row] }));
    const out = await new PgKnowledgeStore(client).outgoing("acme", "scorecard:acme:sc1", "evaluates");
    expect(calls[0]?.text).toContain("AND predicate = $3");
    expect(calls[0]?.params).toEqual(["acme", "scorecard:acme:sc1", "evaluates"]);
    // NULL columns are dropped so the schema's optional/XOR invariants hold on the way back
    expect(out[0]?.objectNodeId).toBe("harness:acme:web-agent@2.1.0");
    expect(out[0]?.subjectMentionId).toBeUndefined();
  });

  it("omits the predicate clause when none is given", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgKnowledgeStore(client).incoming("acme", "harness:acme:web-agent@2.1.0");
    expect(calls[0]?.text).not.toContain("predicate =");
    expect(calls[0]?.params).toEqual(["acme", "harness:acme:web-agent@2.1.0"]);
  });

  it("lists node ids by type and deletes only node rows (the reindex prune)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [{ node_id: "scorecard:acme:sc1" }] }));
    const store = new PgKnowledgeStore(client);

    const ids = await store.listNodeIds("acme", ["scorecard", "run"]);
    expect(ids).toEqual(["scorecard:acme:sc1"]);
    expect(calls[0]?.text).toContain("SELECT node_id FROM everdict_knowledge_nodes");
    expect(calls[0]?.text).toContain("type = ANY($2)");
    expect(calls[0]?.params).toEqual(["acme", ["scorecard", "run"]]);

    await store.deleteNodes("acme", ["scorecard:acme:sc1"]);
    expect(calls[1]?.text).toContain("DELETE FROM everdict_knowledge_nodes");
    expect(calls[1]?.text).not.toContain("mentions"); // the audit spine is never touched
    expect(calls[1]?.params).toEqual(["acme", ["scorecard:acme:sc1"]]);

    await store.deleteNodes("acme", []); // nothing stale — no round-trip at all
    expect(calls).toHaveLength(2);
  });
});
