import {
  type Dataset,
  EdgeMentionSchema,
  type HarnessSpec,
  type JudgeSpec,
  MentionSchema,
  type RuntimeSpec,
} from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type SpecHarvestMeta, harvestDataset, harvestHarness, harvestJudge, harvestRuntime } from "./harvest-specs.js";
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

describe("harvestDataset", () => {
  it("materialises the version-pinned dataset node with its tags", () => {
    const ds: Dataset = {
      id: "web-bench",
      version: "1.0.0",
      cases: [
        { id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", timeoutSec: 60, tags: [], graders: [] },
      ],
      tags: ["web", "regression"],
    };
    const res = harvestDataset(meta, ds);
    expect(res.nodes[0]?.nodeId).toBe(nodeId("acme", { type: "dataset", key: "web-bench", version: "1.0.0" }));
    const tagEdges = res.edges.filter((e) => e.predicate === "tagged_with").map((e) => e.objectNodeId);
    expect(tagEdges).toContain(nodeId("acme", { type: "tag", key: "web" }));
    expect(tagEdges).toContain(nodeId("acme", { type: "tag", key: "regression" }));
    expect(preds(res.edges).get("created_by")).toBe(nodeId("acme", { type: "user", key: "user-alice" }));
    valid(res);
  });
});

describe("harvestHarness", () => {
  it("materialises the harness node and pulls command env secret refs into uses_secret", () => {
    const spec: HarnessSpec = {
      kind: "command",
      id: "aider",
      version: "1.2.0",
      command: "aider --message {{task}} --model {{model}}",
      env: { OPENAI_API_KEY: { secretRef: "openai-key" }, LOG_LEVEL: "info" },
      model: { ref: "gpt5-mini", version: "1.0.0" },
      setup: [],
      params: {},
      trace: { kind: "none" },
    };
    const res = harvestHarness({ ...meta, tags: ["cli"] }, spec);
    expect(res.nodes[0]?.nodeId).toBe(nodeId("acme", { type: "harness", key: "aider", version: "1.2.0" }));
    const p = preds(res.edges);
    expect(p.get("uses_model")).toBe(nodeId("acme", { type: "model", key: "gpt5-mini", version: "1.0.0" }));
    expect(p.get("uses_secret")).toBe(nodeId("acme", { type: "secret", key: "openai-key" }));
    expect(res.edges.some((e) => e.predicate === "tagged_with")).toBe(true);
    valid(res);
  });
});

describe("harvestJudge", () => {
  it("wires a model judge to its registered model and rubric ref", () => {
    const spec: JudgeSpec = {
      kind: "model",
      id: "correctness",
      version: "1.0.0",
      provider: "anthropic",
      model: { ref: "opus", version: "1.0.0" },
      rubric: { id: "strict-rubric", version: "2.0.0" },
      inputs: ["trace"],
      tags: [],
    };
    const p = preds(harvestJudge(meta, spec).edges);
    expect(p.get("uses_model")).toBe(nodeId("acme", { type: "model", key: "opus", version: "1.0.0" }));
    expect(p.get("uses_rubric")).toBe(nodeId("acme", { type: "rubric", key: "strict-rubric", version: "2.0.0" }));
  });

  it("does not emit uses_model for a raw-string model binding", () => {
    const spec: JudgeSpec = {
      kind: "model",
      id: "j",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8", // raw name, not a registry ref
      rubric: "be strict",
      inputs: ["trace"],
      tags: [],
    };
    expect(preds(harvestJudge(meta, spec).edges).has("uses_model")).toBe(false);
  });

  it("wires a code judge to its runtime", () => {
    const spec: JudgeSpec = {
      kind: "code",
      id: "checker",
      version: "1.0.0",
      language: "python",
      code: "print('[]')",
      timeoutSec: 600,
      runtime: "prod-k8s",
      tags: [],
    };
    expect(preds(harvestJudge(meta, spec).edges).get("runs_on")).toBe(
      nodeId("acme", { type: "runtime", key: "prod-k8s" }),
    );
  });
});

describe("harvestRuntime", () => {
  it("materialises a k8s runtime and pulls its auth secret names into uses_secret", () => {
    const spec: RuntimeSpec = {
      kind: "k8s",
      id: "prod-k8s",
      version: "1.0.0",
      tags: [],
      image: "everdict-job-runner:1",
      server: "https://k8s.internal",
      authSecret: "k8s-token",
      kubeconfigSecret: "k8s-config",
    };
    const secretEdges = harvestRuntime(meta, spec)
      .edges.filter((e) => e.predicate === "uses_secret")
      .map((e) => e.objectNodeId);
    expect(secretEdges).toContain(nodeId("acme", { type: "secret", key: "k8s-token" }));
    expect(secretEdges).toContain(nodeId("acme", { type: "secret", key: "k8s-config" }));
  });
});
