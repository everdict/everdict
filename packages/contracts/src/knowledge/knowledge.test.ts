import { describe, expect, it } from "vitest";
import { KnowledgePinSchema, NodeRefSchema } from "./node-ref.js";
import { NODE_TYPES } from "./node-type.js";
import { SOURCE_KINDS } from "./source-kind.js";

// The vocabularies are CLOSED, PR-gated, and part of the storage contract: stored knowledge entries and skills parse
// `refs` / `evidence` / `extraction.sourceKind` against them. A change to a count here is a deliberate, reviewed
// extension — and a DROP makes every stored row naming the removed value unreadable.
describe("knowledge reference vocabularies are closed", () => {
  it("has the expected entity-type and source-kind cardinality with no duplicates", () => {
    expect(NODE_TYPES).toHaveLength(30); // -team, -cycle (the workspace is the only boundary)
    expect(SOURCE_KINDS).toHaveLength(23);
    expect(new Set(NODE_TYPES).size).toBe(NODE_TYPES.length);
    expect(new Set(SOURCE_KINDS).size).toBe(SOURCE_KINDS.length);
  });
});

describe("NodeRef / KnowledgePin", () => {
  it("accepts a version-pinned reference and an interval-extended pin", () => {
    expect(NodeRefSchema.safeParse({ type: "harness", key: "web-agent", version: "2.1.0" }).success).toBe(true);
    const pin = KnowledgePinSchema.parse({
      type: "harness",
      key: "web-agent",
      version: "2.1.0",
      verifiedVersion: "2.3.0",
    });
    expect(pin.verifiedVersion).toBe("2.3.0");
  });

  it("refuses a type outside the closed vocabulary (no fallback) and an empty key", () => {
    expect(NodeRefSchema.safeParse({ type: "team", key: "platform" }).success).toBe(false);
    expect(NodeRefSchema.safeParse({ type: "harness", key: "" }).success).toBe(false);
  });
});
