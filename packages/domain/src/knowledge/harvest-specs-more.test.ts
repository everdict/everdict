import {
  type AgentSpec,
  type CapabilityRecord,
  EdgeMentionSchema,
  MentionSchema,
  type ModelSpec,
  type RubricSpec,
} from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type SpecHarvestMeta, harvestAgent, harvestCapability, harvestModel, harvestRubric } from "./harvest-specs.js";
import { nodeId } from "./ids.js";

const meta: SpecHarvestMeta = {
  tenant: "acme",
  createdAt: "2026-07-27T00:00:00Z",
  updatedAt: "2026-07-27T00:00:00Z",
  createdBy: "user-alice",
};
function preds(edges: { predicate: string; objectNodeId?: string }[]): Map<string, string | undefined> {
  return new Map(edges.map((e) => [e.predicate, e.objectNodeId]));
}
function valid(r: { mentions: unknown[]; edges: unknown[] }): void {
  for (const m of r.mentions) expect(MentionSchema.safeParse(m).success).toBe(true);
  for (const e of r.edges) expect(EdgeMentionSchema.safeParse(e).success).toBe(true);
}

describe("harvestModel", () => {
  it("materialises the model node and pulls its api-key secret into uses_secret", () => {
    const spec: ModelSpec = {
      id: "opus",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
      apiKeySecret: "ANTHROPIC_KEY",
      tags: ["premium"],
    };
    const res = harvestModel(meta, spec);
    expect(res.nodes[0]?.nodeId).toBe(nodeId("acme", { type: "model", key: "opus", version: "1.0.0" }));
    expect(preds(res.edges).get("uses_secret")).toBe(nodeId("acme", { type: "secret", key: "ANTHROPIC_KEY" }));
    expect(res.edges.some((e) => e.predicate === "tagged_with")).toBe(true);
    valid(res);
  });
});

describe("harvestRubric", () => {
  it("materialises the rubric node", () => {
    const spec: RubricSpec = { id: "strict", version: "2.0.0", text: "be strict", tags: [] };
    const res = harvestRubric(meta, spec);
    expect(res.nodes[0]?.type).toBe("rubric");
    valid(res);
  });
});

describe("harvestAgent", () => {
  it("wires uses_model, a cross-tenant adopts edge, and the adoption secret binding", () => {
    const spec: AgentSpec = {
      id: "assistant",
      version: "1.0.0",
      triggers: [],
      enabled: false,
      toolSecretBindings: {},
      mcpServers: [{ name: "internal", url: "https://mcp.internal", authSecret: "MCP_TOKEN", write: false }],
      capabilities: [
        {
          source: "_everdict",
          id: "web-search",
          version: "3.0.0",
          secretBindings: { API_KEY: "MY_SEARCH_KEY" },
          enableWrite: false,
        },
      ],
      disabledDefaults: [],
      model: "opus",
      tags: [],
    };
    const res = harvestAgent(meta, spec);
    const p = preds(res.edges);
    expect(p.get("uses_model")).toBe(nodeId("acme", { type: "model", key: "opus" }));
    // the adopted capability lives in ITS OWNER's tenant (_everdict), not the adopting workspace (acme)
    expect(p.get("adopts")).toBe(nodeId("_everdict", { type: "capability", key: "web-search", version: "3.0.0" }));
    const secrets = res.edges.filter((e) => e.predicate === "uses_secret").map((e) => e.objectNodeId);
    expect(secrets).toContain(nodeId("acme", { type: "secret", key: "MCP_TOKEN" }));
    expect(secrets).toContain(nodeId("acme", { type: "secret", key: "MY_SEARCH_KEY" }));
    valid(res);
  });
});

describe("harvestCapability", () => {
  it("materialises the capability node from a record (no meta needed) with its owner + tags", () => {
    const record: CapabilityRecord = {
      id: "web-search",
      tenant: "_everdict",
      version: "3.0.0",
      name: "Web Search",
      description: "search the web",
      spec: {
        type: "mcp",
        url: "https://mcp.example",
        args: [],
        provides: ["search"],
        requiredSecrets: [],
        write: false,
      },
      visibility: "public",
      sharedWith: [],
      tags: ["search"],
      createdBy: "sys",
      createdAt: "2026-07-27T00:00:00Z",
    };
    const res = harvestCapability(record);
    expect(res.nodes[0]?.nodeId).toBe(nodeId("_everdict", { type: "capability", key: "web-search", version: "3.0.0" }));
    expect(preds(res.edges).get("created_by")).toBe(nodeId("_everdict", { type: "user", key: "sys" }));
    expect(res.edges.some((e) => e.predicate === "tagged_with")).toBe(true);
    valid(res);
  });
});
