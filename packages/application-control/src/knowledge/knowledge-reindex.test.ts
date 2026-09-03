import type { EdgeMention, IssueRecord, KnowledgeNode, Mention, ScorecardRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { KnowledgeStore } from "../ports/knowledge-store.js";
import { KnowledgeService } from "./knowledge-service.js";

// The execution-admission rule: run/scorecard records are EVIDENCE, not inventory — reindex materialises one only
// while something references it (an issue link/resolution, knowledge evidence, a capability origin) and prunes the
// node when the reference goes away. The mention/edge audit spine is never touched.

function memoryStore(): KnowledgeStore & { nodeRows: Map<string, KnowledgeNode>; edgeRows: Map<string, EdgeMention> } {
  const nodeRows = new Map<string, KnowledgeNode>();
  const edgeRows = new Map<string, EdgeMention>();
  const mentionRows = new Map<string, Mention>();
  return {
    nodeRows,
    edgeRows,
    putMentions: async (ms) => {
      for (const m of ms) if (!mentionRows.has(m.id)) mentionRows.set(m.id, m);
    },
    putEdges: async (es) => {
      for (const e of es) if (!edgeRows.has(e.id)) edgeRows.set(e.id, e);
    },
    putNodes: async (ns) => {
      for (const n of ns) nodeRows.set(n.nodeId, n);
    },
    getNode: async (_t, id) => nodeRows.get(id),
    outgoing: async () => [],
    incoming: async () => [],
    listMentions: async () => [],
    notesForNode: async () => [],
    listNodeIds: async (tenant, types) =>
      [...nodeRows.values()].filter((n) => n.tenant === tenant && types.includes(n.type)).map((n) => n.nodeId),
    deleteNodes: async (tenant, ids) => {
      for (const id of ids) if (nodeRows.get(id)?.tenant === tenant) nodeRows.delete(id);
    },
  };
}

const scorecard = (id: string): ScorecardRecord => ({
  id,
  tenant: "acme",
  dataset: { id: "web-bench", version: "1.0.0" },
  harness: { id: "web-agent", version: "2.1.0" },
  status: "succeeded",
  createdBy: "user-alice",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T01:00:00Z",
});

const issue = (overrides: Partial<IssueRecord> = {}): IssueRecord => ({
  id: "i1",
  tenant: "acme",
  number: 12,
  identifier: "ENG-12",
  formerIdentifiers: [],
  title: "Judge misses truncated answers",
  status: "done",
  priority: "none",
  labelIds: [],
  links: [],
  history: [],
  createdBy: "user-alice",
  createdAt: "2026-07-30T00:00:00Z",
  updatedAt: "2026-08-02T00:00:00Z",
  ...overrides,
});

describe("KnowledgeService.reindex — the execution-admission rule", () => {
  it("materialises a scorecard only while an issue references it, and the issue hub around it", async () => {
    const store = memoryStore();
    const svc = new KnowledgeService({
      store,
      reindexSources: {
        issues: {
          list: async () => [
            issue({ resolution: { scorecardId: "sc-proof", by: "user-alice", at: "2026-08-02T00:00:00Z" } }),
          ],
        },
        scorecards: { list: async () => [scorecard("sc-proof"), scorecard("sc-noise")] },
      },
    });

    const res = await svc.reindex("acme");

    // The referenced scorecard is on the graph; the unreferenced one never materialises.
    expect(store.nodeRows.has("scorecard:acme:sc-proof")).toBe(true);
    expect(store.nodeRows.has("scorecard:acme:sc-noise")).toBe(false);
    // The issue hub is materialised with its resolution edge.
    expect(store.nodeRows.get("issue:acme:i1")?.label).toBe("ENG-12 · Judge misses truncated answers");
    const resolved = [...store.edgeRows.values()].find((e) => e.predicate === "resolved_by");
    expect(resolved?.objectNodeId).toBe("scorecard:acme:sc-proof");
    expect(res.pruned).toBe(0);
  });

  it("admits execution records through issue LINKS too, with the link note on the verified_by edge", async () => {
    const store = memoryStore();
    const svc = new KnowledgeService({
      store,
      reindexSources: {
        issues: {
          list: async () => [
            issue({
              links: [
                { type: "scorecard", id: "sc-linked", note: "baseline", addedBy: "u", addedAt: "2026-08-01T00:00:00Z" },
              ],
            }),
          ],
        },
        scorecards: { list: async () => [scorecard("sc-linked")] },
      },
    });

    await svc.reindex("acme");
    expect(store.nodeRows.has("scorecard:acme:sc-linked")).toBe(true);
    const verified = [...store.edgeRows.values()].find((e) => e.predicate === "verified_by");
    expect(verified?.objectNodeId).toBe("scorecard:acme:sc-linked");
    expect(verified?.edgeAttrs).toMatchObject({ note: "baseline" });
  });

  it("prunes a previously materialised execution node whose reference went away — spine untouched", async () => {
    const store = memoryStore();
    // A scorecard node from an earlier reindex, when an issue still referenced it.
    store.nodeRows.set("scorecard:acme:sc-old", {
      nodeId: "scorecard:acme:sc-old",
      tenant: "acme",
      type: "scorecard",
      key: "sc-old",
      label: "old batch",
      attrs: {},
      resolution: "resolved",
      evidenceCount: 1,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const svc = new KnowledgeService({
      store,
      reindexSources: {
        issues: { list: async () => [issue()] }, // no links, no resolution any more
        scorecards: { list: async () => [scorecard("sc-old")] },
      },
    });

    const res = await svc.reindex("acme");
    expect(res.pruned).toBe(1);
    expect(store.nodeRows.has("scorecard:acme:sc-old")).toBe(false);
    expect(store.nodeRows.has("issue:acme:i1")).toBe(true);
  });

  it("never prunes a type whose source is not wired (a partial deployment must not retract others' projections)", async () => {
    const store = memoryStore();
    store.nodeRows.set("run:acme:r-old", {
      nodeId: "run:acme:r-old",
      tenant: "acme",
      type: "run",
      key: "r-old",
      label: "old run",
      attrs: {},
      resolution: "resolved",
      evidenceCount: 1,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const svc = new KnowledgeService({
      store,
      reindexSources: { issues: { list: async () => [issue()] } }, // runs source absent
    });

    const res = await svc.reindex("acme");
    expect(res.pruned).toBe(0);
    expect(store.nodeRows.has("run:acme:r-old")).toBe(true);
  });

  it("a capability version's origin admits the scorecard it was born from, and emits the born_from edge", async () => {
    const store = memoryStore();
    const svc = new KnowledgeService({
      store,
      reindexSources: {
        datasets: {
          get: async () => ({ id: "web-bench", version: "2.0.0", cases: [], tags: [] }),
          list: async () => [
            {
              id: "web-bench",
              owner: "acme",
              versions: ["2.0.0"],
              latestVersion: "2.0.0",
              caseCount: 0,
              tags: [],
              createdBy: "user-alice",
              versionOrigins: {
                "2.0.0": { via: "mcp" as const, from: { type: "scorecard" as const, id: "sc-birth" } },
              },
            },
          ],
        },
        scorecards: { list: async () => [scorecard("sc-birth"), scorecard("sc-noise")] },
      },
    });

    await svc.reindex("acme");
    expect(store.nodeRows.has("scorecard:acme:sc-birth")).toBe(true);
    expect(store.nodeRows.has("scorecard:acme:sc-noise")).toBe(false);
    const born = [...store.edgeRows.values()].find((e) => e.predicate === "born_from");
    expect(born?.subjectNodeId).toBe("dataset:acme:web-bench@2.0.0");
    expect(born?.objectNodeId).toBe("scorecard:acme:sc-birth");
    expect(born?.edgeAttrs).toMatchObject({ via: "mcp" });
  });
});
