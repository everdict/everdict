import type { KnowledgeEntryRecord, SkillRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { KnowledgeStore } from "../ports/knowledge-store.js";
import { KnowledgeService } from "./knowledge-service.js";

// Context assembly reads the RECORDS (always current), the graph only for structural facts — so a bare KnowledgeStore
// with no harvested edges still yields the knowledge/skill lanes.
const emptyGraph: KnowledgeStore = {
  putMentions: async () => {},
  putEdges: async () => {},
  putNodes: async () => {},
  getNode: async () => undefined,
  outgoing: async () => [],
  incoming: async () => [],
  listMentions: async () => [],
  notesForNode: async () => [],
};

const skill = (
  id: string,
  refs: SkillRecord["refs"],
  visibility: SkillRecord["visibility"] = "workspace",
): SkillRecord => ({
  id,
  tenant: "acme",
  name: id,
  description: `${id} desc`,
  instructions: "SECRET-BODY", // must NOT appear in the assembled context (listing-level only)
  version: "1.0.0",
  files: [],
  refs,
  visibility,
  createdBy: "alice",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
});

const entry = (
  id: string,
  refs: KnowledgeEntryRecord["refs"],
  status: KnowledgeEntryRecord["status"] = "active",
  updatedAt = "2026-07-01T00:00:00.000Z",
): KnowledgeEntryRecord => ({
  id,
  tenant: "acme",
  kind: "finding",
  title: `${id} title`,
  body: "…",
  refs,
  evidence: [],
  status,
  visibility: "workspace",
  createdBy: "alice",
  createdAt: updatedAt,
  updatedAt,
});

describe("KnowledgeService.assembleContext", () => {
  const webAgent = { type: "harness" as const, key: "web-agent" };

  it("family-matches records to anchors (version-agnostic), labels relations, decorates coverage, and keeps skills listing-level", async () => {
    const svc = new KnowledgeService({
      store: emptyGraph,
      contextSources: {
        skills: {
          list: async () => [
            skill("triage", [{ ...webAgent, version: "2.1.0" }]),
            skill("unrelated", [{ type: "dataset", key: "other" }]),
          ],
        },
        knowledgeEntries: {
          list: async () => [
            entry("old-deprecated", [{ ...webAgent, version: "2.0.0" }], "deprecated", "2026-07-10T00:00:00.000Z"),
            entry("live-claim", [{ ...webAgent, version: "2.1.0" }], "active", "2026-07-05T00:00:00.000Z"),
            entry("unrelated", [{ type: "judge", key: "j1" }]),
          ],
        },
        latestVersionOf: async (_t, ref) => (ref.key === "web-agent" ? "2.3.0" : undefined),
      },
    });

    // The task anchors a NEWER version of the harness — family matching still surfaces claims pinned to 2.1.0.
    const ctx = await svc.assembleContext("acme", "alice", [{ ...webAgent, version: "2.3.0" }]);

    expect(ctx.anchors[0]?.nodeId).toBe("harness:acme:web-agent@2.3.0");
    expect(ctx.anchors[0]?.facts).toEqual([]);

    expect(ctx.knowledge.map((k) => k.id)).toEqual(["live-claim", "old-deprecated"]); // same tier → active first
    expect(ctx.knowledge[0]?.relation).toBe("earlier"); // pinned at 2.1.0 — an earlier point of the 2.3.0 anchor
    expect(ctx.knowledge[0]?.coverage?.state).toBe("behind"); // interval ends at 2.1.0, present is 2.3.0

    expect(ctx.skills.map((s) => s.id)).toEqual(["triage"]);
    expect(ctx.skills[0]?.coverage?.state).toBe("behind");
    expect(JSON.stringify(ctx.skills)).not.toContain("SECRET-BODY"); // no instructions body in the context payload
  });

  it("projects onto a PAST anchor coordinate: a superseded claim covering it outranks an active claim from its future", async () => {
    const svc = new KnowledgeService({
      store: emptyGraph,
      contextSources: {
        knowledgeEntries: {
          list: async () => [
            // the then-truth: pinned at 2.1.0, since superseded by the fix note
            entry("then-truth", [{ ...webAgent, version: "2.1.0" }], "superseded", "2026-07-01T00:00:00.000Z"),
            // the fix, observed at 2.2.0 — this coordinate's FUTURE
            entry("the-fix", [{ ...webAgent, version: "2.2.0" }], "active", "2026-07-20T00:00:00.000Z"),
          ],
        },
        latestVersionOf: async () => "2.3.0",
      },
    });

    // analyzing an old scorecard that ran harness@2.1.0 — the anchor's version IS the as-of coordinate
    const ctx = await svc.assembleContext("acme", "alice", [{ ...webAgent, version: "2.1.0" }]);
    expect(ctx.knowledge.map((k) => k.id)).toEqual(["then-truth", "the-fix"]);
    expect(ctx.knowledge[0]?.relation).toBe("covers"); // superseded, but the truth AT this coordinate
    expect(ctx.knowledge[1]?.relation).toBe("later"); // the "what happened next" trail, ranked after
  });

  it("returns empty lanes when no context sources are wired (graph-only deployment)", async () => {
    const svc = new KnowledgeService({ store: emptyGraph });
    const ctx = await svc.assembleContext("acme", "alice", [webAgent]);
    expect(ctx.knowledge).toEqual([]);
    expect(ctx.skills).toEqual([]);
    expect(ctx.anchors).toHaveLength(1);
  });
});
