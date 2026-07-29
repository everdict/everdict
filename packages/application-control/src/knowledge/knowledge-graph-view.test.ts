import type { EdgeMention, KnowledgeEntryRecord, KnowledgeNode, SkillRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { KnowledgeStore } from "../ports/knowledge-store.js";
import { KnowledgeService } from "./knowledge-service.js";

// The graph read-model backs the rendered map (Settings › Knowledge). The knowledge layer must be on it LIVE — an
// unharvested workspace is the normal state right after someone writes their first claim.

const emptyStore: KnowledgeStore = {
  putMentions: async () => {},
  putEdges: async () => {},
  putNodes: async () => {},
  getNode: async () => undefined,
  outgoing: async () => [],
  incoming: async () => [],
  listMentions: async () => [],
  notesForNode: async () => [],
};

const entry = (
  id: string,
  refs: KnowledgeEntryRecord["refs"],
  overrides: Partial<KnowledgeEntryRecord> = {},
): KnowledgeEntryRecord => ({
  id,
  tenant: "acme",
  kind: "finding",
  title: `${id} title`,
  body: "…",
  refs,
  evidence: [],
  status: "active",
  visibility: "workspace",
  createdBy: "alice",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...overrides,
});

const skill = (id: string, refs: SkillRecord["refs"]): SkillRecord => ({
  id,
  tenant: "acme",
  name: id,
  description: `${id} desc`,
  instructions: "…",
  files: [],
  refs,
  visibility: "workspace",
  createdBy: "alice",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
});

describe("KnowledgeService.graph", () => {
  const webAgent = { type: "harness" as const, key: "web-agent", version: "2.1.0" };

  it("renders the knowledge layer from its records, without waiting for a reindex", async () => {
    const svc = new KnowledgeService({
      store: emptyStore,
      contextSources: {
        skills: { list: async () => [skill("triage", [webAgent])] },
        knowledgeEntries: {
          list: async () => [
            entry("flaky-login", [webAgent]),
            entry("draft", [webAgent], { visibility: "private" }), // someone's private draft
            entry("candidate", [webAgent], { status: "proposed" }), // unreviewed extraction
          ],
        },
      },
    });

    const graph = await svc.graph("acme");

    // The claim + the skill are on the map; the private draft and the unreviewed candidate are not.
    expect(graph.nodes.map((n) => n.nodeId)).toContain("knowledge:acme:flaky-login");
    expect(graph.nodes.map((n) => n.nodeId)).toContain("skill:acme:triage");
    expect(graph.nodes.map((n) => n.key)).not.toContain("draft");
    expect(graph.nodes.map((n) => n.key)).not.toContain("candidate");
    expect(graph.stats.nodesByType.knowledge).toBe(1);

    // …and each is CONNECTED to what it concerns: the pinned harness is materialised as a pending reference, so the
    // claim is not stranded as an orphan dot before that entity's own harvester ever runs.
    const pinned = graph.nodes.find((n) => n.nodeId === "harness:acme:web-agent@2.1.0");
    expect(pinned?.resolution).toBe("dangling");
    expect(pinned?.label).toBe("web-agent@2.1.0");
    expect(
      graph.edges.filter((e) => e.predicate === "about" && e.objectNodeId === "harness:acme:web-agent@2.1.0"),
    ).toHaveLength(2);
  });

  it("ships only what the map can draw: no half-dangling edges, no audit spine", async () => {
    const svc = new KnowledgeService({
      store: emptyStore,
      contextSources: { knowledgeEntries: { list: async () => [entry("flaky-login", [webAgent])] } },
    });

    const graph = await svc.graph("acme");

    // The claim's `in_workspace` / `created_by` edges point at a hub and a user nobody materialised — undrawable,
    // unlistable, and (on a real workspace) two thirds of the payload.
    expect(graph.edges.map((e) => e.predicate).sort()).toEqual(["about"]);
    expect(graph.stats.totalEdges).toBe(1);
    for (const e of graph.edges) {
      expect(graph.nodes.some((n) => n.nodeId === e.subjectNodeId)).toBe(true);
      expect(graph.nodes.some((n) => n.nodeId === e.objectNodeId)).toBe(true);
      // Provenance lives on `related` / `node` / listMentions, not on every edge of a whole-workspace render payload.
      expect(e).not.toHaveProperty("evidencePath");
      expect(e).not.toHaveProperty("sourceId");
      expect(e).not.toHaveProperty("confidence");
    }
  });

  it("never shadows a harvested node with a reference stub", async () => {
    const harvested: KnowledgeNode = {
      nodeId: "harness:acme:web-agent@2.1.0",
      tenant: "acme",
      type: "harness",
      key: "web-agent",
      version: "2.1.0",
      label: "Web agent",
      attrs: { kind: "command" },
      resolution: "resolved",
      evidenceCount: 3,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    // Reachable the way every harvested entity is: by its `in_workspace` edge to the hub the BFS starts from.
    const scoping: EdgeMention = {
      id: "edg_scoping",
      tenant: "acme",
      predicate: "in_workspace",
      subjectNodeId: harvested.nodeId,
      objectNodeId: "workspace:acme:acme",
      objectTypeHint: "workspace",
      edgeAttrs: {},
      polarity: "affirmed",
      sourceKind: "harness_spec",
      sourceId: "web-agent",
      origin: "harvest",
      extractor: "harness_harvester_v1",
      confidence: 1,
      evidencePath: "tenant",
      resolution: "resolved",
      createdAt: "2026-06-01T00:00:00.000Z",
    };
    const svc = new KnowledgeService({
      store: {
        ...emptyStore,
        getNode: async (_t, id) => (id === harvested.nodeId ? harvested : undefined),
        outgoing: async (_t, id) => (id === harvested.nodeId ? [scoping] : []),
        incoming: async (_t, id) => (id === "workspace:acme:acme" ? [scoping] : []),
      },
      contextSources: { knowledgeEntries: { list: async () => [entry("flaky-login", [webAgent])] } },
    });

    const graph = await svc.graph("acme");
    const node = graph.nodes.find((n) => n.nodeId === harvested.nodeId);
    expect(node?.label).toBe("Web agent"); // the real row, not the "web-agent@2.1.0" stub
    expect(node?.resolution).toBe("resolved");
  });
});
