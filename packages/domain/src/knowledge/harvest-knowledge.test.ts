import { EdgeMentionSchema, type KnowledgeEntryRecord, MentionSchema, type SkillRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { assessFreshness } from "./freshness.js";
import { harvestKnowledgeEntry, harvestSkill } from "./harvest-knowledge.js";
import { nodeId } from "./ids.js";

function assertValid(r: { mentions: unknown[]; edges: unknown[] }): void {
  for (const m of r.mentions) expect(MentionSchema.safeParse(m).success).toBe(true);
  for (const e of r.edges) expect(EdgeMentionSchema.safeParse(e).success).toBe(true);
}

const skill: SkillRecord = {
  id: "sk1",
  tenant: "acme",
  name: "scorecard-triage",
  description: "how to triage a regressed scorecard",
  instructions: "…",
  files: [],
  refs: [
    { type: "harness", key: "web-agent", version: "2.1.0" },
    { type: "dataset", key: "login-cases", version: "3.0.0" },
  ],
  visibility: "workspace",
  createdBy: "user-alice",
  createdAt: "2026-07-28T00:00:00Z",
  updatedAt: "2026-07-28T01:00:00Z",
};

describe("harvestSkill", () => {
  it("projects the skill node plus about edges for each version-pinned ref", () => {
    const r = harvestSkill(skill);
    assertValid(r);
    expect(r.nodes[0]?.nodeId).toBe(nodeId("acme", { type: "skill", key: "sk1" }));
    const abouts = r.edges.filter((e) => e.predicate === "about").map((e) => e.objectNodeId);
    expect(abouts).toEqual([
      nodeId("acme", { type: "harness", key: "web-agent", version: "2.1.0" }),
      nodeId("acme", { type: "dataset", key: "login-cases", version: "3.0.0" }),
    ]);
    expect(r.edges.some((e) => e.predicate === "created_by")).toBe(true);
  });

  it("is idempotent — the same record yields the same ids", () => {
    const a = harvestSkill(skill);
    const b = harvestSkill(skill);
    expect(a.edges.map((e) => e.id)).toEqual(b.edges.map((e) => e.id));
  });
});

const entry: KnowledgeEntryRecord = {
  id: "kn1",
  tenant: "acme",
  kind: "finding",
  title: "login cases are flaky on k8s",
  body: "Variance only shows on the k8s runtime.",
  refs: [{ type: "harness", key: "web-agent", version: "2.1.0" }],
  evidence: [{ type: "scorecard", key: "sc-9" }],
  status: "active",
  supersedes: "kn0",
  visibility: "workspace",
  createdBy: "user-alice",
  createdAt: "2026-07-28T00:00:00Z",
  updatedAt: "2026-07-28T01:00:00Z",
};

describe("harvestKnowledgeEntry", () => {
  it("projects a knowledge node with about + evidenced_by + supersedes edges", () => {
    const r = harvestKnowledgeEntry(entry);
    assertValid(r);
    expect(r.nodes[0]?.type).toBe("knowledge");
    expect(r.nodes[0]?.label).toBe(entry.title);
    const byPredicate = new Map(r.edges.map((e) => [e.predicate, e.objectNodeId]));
    expect(byPredicate.get("about")).toBe(nodeId("acme", { type: "harness", key: "web-agent", version: "2.1.0" }));
    expect(byPredicate.get("evidenced_by")).toBe(nodeId("acme", { type: "scorecard", key: "sc-9" }));
    expect(byPredicate.get("supersedes")).toBe(nodeId("acme", { type: "knowledge", key: "kn0" }));
  });
});

describe("assessFreshness", () => {
  const now = "2026-07-28T12:00:00Z";
  const latest = (versions: Record<string, string>) => (ref: { type: string; key: string }) =>
    versions[`${ref.type}:${ref.key}`];

  it("flags superseded refs when a pinned target has a newer version", () => {
    const f = assessFreshness(skill, latest({ "harness:web-agent": "2.3.0" }), { now });
    expect(f.state).toBe("superseded_refs");
    expect(f.staleRefs).toEqual([{ ref: skill.refs[0], latest: "2.3.0" }]);
  });

  it("is fresh when every pinned target is still the latest", () => {
    const f = assessFreshness(skill, latest({ "harness:web-agent": "2.1.0", "dataset:login-cases": "3.0.0" }), {
      now,
    });
    expect(f.state).toBe("fresh");
  });

  it("falls to unverified after the age limit, measured from verifiedAt when present", () => {
    const old = { ...skill, updatedAt: "2026-01-01T00:00:00Z" };
    expect(assessFreshness(old, () => undefined, { now }).state).toBe("unverified");
    const reverified = { ...old, verifiedAt: "2026-07-27T00:00:00Z" };
    expect(assessFreshness(reverified, () => undefined, { now }).state).toBe("fresh");
  });

  it("ignores unpinned refs and unknown targets (no staleness contract, no false alarms)", () => {
    const unpinned = { ...skill, refs: [{ type: "harness" as const, key: "web-agent" }] };
    expect(assessFreshness(unpinned, latest({ "harness:web-agent": "9.9.9" }), { now }).state).toBe("fresh");
    expect(assessFreshness(skill, () => undefined, { now }).state).toBe("fresh");
  });
});
