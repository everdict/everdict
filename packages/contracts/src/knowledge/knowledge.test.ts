import { describe, expect, it } from "vitest";
import { EdgeMentionSchema } from "./edge-mention.js";
import { MentionSchema } from "./mention.js";
import { NODE_TYPES } from "./node-type.js";
import { PREDICATES } from "./predicate.js";

// The vocabularies are CLOSED and PR-gated. These assertions lock them against silent drift (the digo-data contract-test
// pattern): a change to the count here is a deliberate, reviewed vocabulary extension, not an accident.
describe("knowledge vocabularies are closed", () => {
  it("has the expected node and predicate cardinality with no duplicates", () => {
    expect(NODE_TYPES).toHaveLength(32);
    expect(PREDICATES).toHaveLength(42); // +forked_from (harness-identity-and-seeds-spec.md §1)
    expect(new Set(NODE_TYPES).size).toBe(NODE_TYPES.length);
    expect(new Set(PREDICATES).size).toBe(PREDICATES.length);
  });
});

const baseMention = {
  id: "m1",
  tenant: "acme",
  nodeType: "harness",
  nodeRef: "web-agent",
  sourceKind: "scorecard",
  sourceId: "sc1",
  extractor: "harvester_v1",
  createdAt: "2026-07-27T00:00:00Z",
} as const;

describe("Mention — the audit lock and resolution invariants", () => {
  it("accepts a harvested mention that cites a record field path", () => {
    const r = MentionSchema.safeParse({
      ...baseMention,
      origin: "harvest",
      confidence: 1,
      evidencePath: "harness.id",
      resolution: "resolved",
      resolvedNodeId: "harness:acme:web-agent@1.0.0",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a harvested mention with no evidence path (audit lock)", () => {
    const r = MentionSchema.safeParse({ ...baseMention, origin: "harvest", confidence: 1 });
    expect(r.success).toBe(false);
  });

  it("rejects an extracted mention with no text quote (audit lock)", () => {
    const r = MentionSchema.safeParse({
      ...baseMention,
      sourceKind: "comment",
      sourceId: "c1",
      origin: "extraction",
      confidence: 0.7,
    });
    expect(r.success).toBe(false);
  });

  it("rejects a resolved mention that names no node", () => {
    const r = MentionSchema.safeParse({
      ...baseMention,
      origin: "harvest",
      confidence: 1,
      evidencePath: "harness.id",
      resolution: "resolved",
    });
    expect(r.success).toBe(false);
  });
});

const baseEdge = {
  id: "e1",
  tenant: "acme",
  predicate: "evaluates",
  sourceKind: "scorecard",
  sourceId: "sc1",
  origin: "harvest",
  extractor: "harvester_v1",
  confidence: 1,
  evidencePath: "harness.id",
  createdAt: "2026-07-27T00:00:00Z",
} as const;

describe("EdgeMention — exactly one reference style per side, no self-edge", () => {
  it("accepts one style per side and defaults polarity to affirmed", () => {
    const r = EdgeMentionSchema.safeParse({
      ...baseEdge,
      subjectNodeId: "scorecard:acme:sc1",
      objectNodeId: "harness:acme:web-agent@1.0.0",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.polarity).toBe("affirmed");
  });

  it("rejects both styles on the same side (ambiguous)", () => {
    const r = EdgeMentionSchema.safeParse({
      ...baseEdge,
      subjectNodeId: "scorecard:acme:sc1",
      subjectMentionId: "m1",
      objectNodeId: "harness:acme:web-agent@1.0.0",
    });
    expect(r.success).toBe(false);
  });

  it("rejects neither style on a side (dangling)", () => {
    const r = EdgeMentionSchema.safeParse({ ...baseEdge, subjectNodeId: "scorecard:acme:sc1" });
    expect(r.success).toBe(false);
  });

  it("rejects a self-edge", () => {
    const r = EdgeMentionSchema.safeParse({
      ...baseEdge,
      predicate: "succeeds",
      subjectNodeId: "harness:acme:web-agent@1.0.0",
      objectNodeId: "harness:acme:web-agent@1.0.0",
    });
    expect(r.success).toBe(false);
  });
});
