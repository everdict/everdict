import { describe, expect, it } from "vitest";
import { KNOWLEDGE_ENTRY_MAX_REFS, KnowledgeEntryRecordSchema } from "./knowledge-entry.js";
import { SkillRecordSchema } from "./skill.js";

const baseEntry = {
  id: "kn1",
  tenant: "acme",
  kind: "finding",
  title: "login cases are flaky on k8s",
  body: "Three consecutive scorecards show pass-rate variance only on the k8s runtime.",
  visibility: "workspace",
  createdBy: "user-1",
  createdAt: "2026-07-28T00:00:00Z",
  updatedAt: "2026-07-28T00:00:00Z",
} as const;

describe("KnowledgeEntryRecord — a reified claim", () => {
  it("accepts a minimal entry and defaults refs/evidence/status", () => {
    const r = KnowledgeEntryRecordSchema.parse(baseEntry);
    expect(r.refs).toEqual([]);
    expect(r.evidence).toEqual([]);
    expect(r.status).toBe("active");
    expect(r.verifiedAt).toBeUndefined();
  });

  it("carries version-pinned anchors and evidence refs", () => {
    const r = KnowledgeEntryRecordSchema.parse({
      ...baseEntry,
      refs: [{ type: "harness", key: "web-agent", version: "2.1.0" }],
      evidence: [{ type: "scorecard", key: "sc-1" }],
      supersedes: "kn0",
      status: "active",
    });
    expect(r.refs[0]?.version).toBe("2.1.0");
    expect(r.supersedes).toBe("kn0");
  });

  it("rejects an unknown kind and an empty title (closed vocab, no fallback)", () => {
    expect(KnowledgeEntryRecordSchema.safeParse({ ...baseEntry, kind: "insight" }).success).toBe(false);
    expect(KnowledgeEntryRecordSchema.safeParse({ ...baseEntry, title: "" }).success).toBe(false);
  });

  it("caps refs at the atomic-claim bound", () => {
    const refs = Array.from({ length: KNOWLEDGE_ENTRY_MAX_REFS + 1 }, (_, i) => ({
      type: "harness",
      key: `h${i}`,
    }));
    expect(KnowledgeEntryRecordSchema.safeParse({ ...baseEntry, refs }).success).toBe(false);
  });
});

describe("SkillRecord — the graph-facing additions stay additive", () => {
  const baseSkill = {
    id: "sk1",
    tenant: "acme",
    name: "scorecard-triage",
    description: "how to triage a regressed scorecard",
    instructions: "…",
    visibility: "workspace",
    createdBy: "user-1",
    createdAt: "2026-07-28T00:00:00Z",
    updatedAt: "2026-07-28T00:00:00Z",
  } as const;

  it("parses a pre-existing record with no refs/verifiedAt (backward compatible)", () => {
    const r = SkillRecordSchema.parse(baseSkill);
    expect(r.refs).toEqual([]);
    expect(r.verifiedAt).toBeUndefined();
  });

  it("accepts version-pinned refs the harvester will project as about edges", () => {
    const r = SkillRecordSchema.parse({
      ...baseSkill,
      refs: [{ type: "dataset", key: "login-cases", version: "3.0.0" }],
      verifiedAt: "2026-07-28T00:00:00Z",
    });
    expect(r.refs).toHaveLength(1);
  });
});
