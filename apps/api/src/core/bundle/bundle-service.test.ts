import { readFileSync } from "node:fs";
import { DatasetSchema } from "@everdict/contracts";
import {
  InMemoryBenchmarkRegistry,
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
  InMemoryRubricRegistry,
} from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { BundleSchema, BundleService, requiredActionsForBundle } from "./bundle-service.js";

const DATASET = {
  id: "d",
  version: "1.0.0",
  cases: [{ id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] }],
  tags: [],
};
const JUDGE = {
  kind: "model",
  id: "j1",
  version: "1.0.0",
  provider: "anthropic",
  model: "claude-opus-4-8",
  rubric: "ok?",
  inputs: ["trace"],
  tags: [],
};
const RUBRIC = { id: "r1", version: "1.0.0", text: "did it work?", tags: [] };

const bundle = (over: Record<string, unknown> = {}) =>
  BundleSchema.parse({ id: "codex-pinch", version: "1.0.0", datasets: [DATASET], judges: [JUDGE], ...over });

describe("requiredActionsForBundle", () => {
  it("derives the required per-type actions from the bundle contents (composed, no new action)", () => {
    expect(requiredActionsForBundle(bundle()).sort()).toEqual(["datasets:write", "judges:write"]);
    expect(requiredActionsForBundle(BundleSchema.parse({ id: "x", version: "1", datasets: [DATASET] }))).toEqual([
      "datasets:write",
    ]);
    // rubrics reuse the judging-domain action (no new authz action)
    expect(requiredActionsForBundle(BundleSchema.parse({ id: "x", version: "1", rubrics: [RUBRIC] }))).toEqual([
      "judges:write",
    ]);
    // empty bundle → no required actions
    expect(requiredActionsForBundle(BundleSchema.parse({ id: "x", version: "1" }))).toEqual([]);
  });
});

describe("BundleService.apply", () => {
  it("fans each section out to its existing registry to register, idempotently (re-applying the same content = ok)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    const judges = new InMemoryJudgeRegistry();
    const rubrics = new InMemoryRubricRegistry();
    const svc = new BundleService({ datasets, judges, rubrics });

    const first = await svc.apply("acme", "u-alice", bundle({ rubrics: [RUBRIC] }));
    expect(first.results.map((r) => [r.kind, r.status])).toEqual([
      ["dataset", "ok"],
      ["judge", "ok"],
      ["rubric", "ok"],
    ]);
    // actually registered
    expect((await datasets.get("acme", "d", "1.0.0")).id).toBe("d");
    expect((await rubrics.get("acme", "r1", "1.0.0")).text).toBe("did it work?");

    // idempotent: re-applying the same content is ok with no exception (immutable registry).
    const again = await svc.apply("acme", "u-alice", bundle({ rubrics: [RUBRIC] }));
    expect(again.results.every((r) => r.status === "ok")).toBe(true);
  });

  it("different content at the same (id,version) → only that item conflicts (the batch is not aborted)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    const judges = new InMemoryJudgeRegistry();
    await datasets.register("acme", DatasetSchema.parse({ ...DATASET, description: "original" })); // pre-claim (different content)
    const svc = new BundleService({ datasets, judges });

    const res = await svc.apply("acme", "u-alice", bundle());
    const byKind = Object.fromEntries(res.results.map((r) => [r.kind, r.status]));
    expect(byKind.dataset).toBe("conflict"); // different content → conflict
    expect(byKind.judge).toBe("ok"); // the rest still proceeds
  });

  it("if a section's registry is absent, that item is skipped (the batch continues)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    const svc = new BundleService({ datasets }); // no judges/rubrics registry configured
    const res = await svc.apply("acme", "u-alice", bundle({ rubrics: [RUBRIC] }));
    const byKind = Object.fromEntries(res.results.map((r) => [r.kind, r.status]));
    expect(byKind.dataset).toBe("ok");
    expect(byKind.judge).toBe("skipped");
    expect(byKind.rubric).toBe("skipped");
  });
});

describe("examples/bundles/codex-pinch bundle (artifact guard)", () => {
  it("the real bundle file satisfies the schema and every item applies", async () => {
    const raw = readFileSync(
      new URL("../../../../../examples/bundles/codex-pinch/bundle.json", import.meta.url),
      "utf8",
    );
    const parsed = BundleSchema.parse(JSON.parse(raw));
    const templates = new InMemoryHarnessTemplateRegistry();
    const svc = new BundleService({
      harnessTemplates: templates,
      harnessInstances: new InMemoryHarnessInstanceRegistry(templates),
      datasets: new InMemoryDatasetRegistry(),
      benchmarks: new InMemoryBenchmarkRegistry(),
    });
    const res = await svc.apply("acme", "u", parsed);
    expect(res.results.every((r) => r.status === "ok")).toBe(true); // codex template+instance + pinch recipe + sample dataset
    expect([...new Set(res.results.map((r) => r.kind))].sort()).toEqual([
      "benchmark-recipe",
      "dataset",
      "harness",
      "harness-template",
    ]);
  });
});
