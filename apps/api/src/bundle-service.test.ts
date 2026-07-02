import { readFileSync } from "node:fs";
import { DatasetSchema } from "@assay/core";
import {
  InMemoryBenchmarkRegistry,
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
} from "@assay/registry";
import { describe, expect, it } from "vitest";
import { BenchmarkService } from "./benchmark-service.js";
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

const bundle = (over: Record<string, unknown> = {}) =>
  BundleSchema.parse({ id: "codex-pinch", version: "1.0.0", datasets: [DATASET], judges: [JUDGE], ...over });

describe("requiredActionsForBundle", () => {
  it("번들 내용에서 필요한 per-type 액션을 도출한다(새 액션 없이 조합)", () => {
    expect(requiredActionsForBundle(bundle()).sort()).toEqual(["datasets:write", "judges:write"]);
    expect(requiredActionsForBundle(BundleSchema.parse({ id: "x", version: "1", datasets: [DATASET] }))).toEqual([
      "datasets:write",
    ]);
    // 빈 번들 → 요구 액션 없음
    expect(requiredActionsForBundle(BundleSchema.parse({ id: "x", version: "1" }))).toEqual([]);
  });
});

describe("BundleService.apply", () => {
  it("각 섹션을 기존 레지스트리로 팬아웃해 등록하고 멱등하다(같은 내용 재적용=ok)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    const judges = new InMemoryJudgeRegistry();
    const svc = new BundleService({ datasets, judges });

    const first = await svc.apply("acme", "u-alice", bundle());
    expect(first.results.map((r) => [r.kind, r.status])).toEqual([
      ["dataset", "ok"],
      ["judge", "ok"],
    ]);
    // 실제로 등록됨
    expect((await datasets.get("acme", "d", "1.0.0")).id).toBe("d");

    // 멱등: 같은 내용 재적용는 예외 없이 ok(불변 레지스트리).
    const again = await svc.apply("acme", "u-alice", bundle());
    expect(again.results.every((r) => r.status === "ok")).toBe(true);
  });

  it("같은 (id,version) 에 다른 내용 → 그 항목만 conflict(배치는 중단하지 않음)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    const judges = new InMemoryJudgeRegistry();
    await datasets.register("acme", DatasetSchema.parse({ ...DATASET, description: "original" })); // 선점(다른 내용)
    const svc = new BundleService({ datasets, judges });

    const res = await svc.apply("acme", "u-alice", bundle());
    const byKind = Object.fromEntries(res.results.map((r) => [r.kind, r.status]));
    expect(byKind.dataset).toBe("conflict"); // 다른 내용 → 충돌
    expect(byKind.judge).toBe("ok"); // 그래도 나머지는 계속 진행
  });

  it("섹션의 레지스트리가 없으면 그 항목은 skipped(배치 계속)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    const svc = new BundleService({ datasets }); // judges 레지스트리 미설정
    const res = await svc.apply("acme", "u-alice", bundle());
    const byKind = Object.fromEntries(res.results.map((r) => [r.kind, r.status]));
    expect(byKind.dataset).toBe("ok");
    expect(byKind.judge).toBe("skipped");
  });
});

describe("examples/bundles/codex-pinch bundle (아티팩트 가드)", () => {
  it("실제 번들 파일이 스키마를 만족하고 전 항목이 적용된다", async () => {
    const raw = readFileSync(new URL("../../../examples/bundles/codex-pinch/bundle.json", import.meta.url), "utf8");
    const parsed = BundleSchema.parse(JSON.parse(raw));
    const templates = new InMemoryHarnessTemplateRegistry();
    const svc = new BundleService({
      harnessTemplates: templates,
      harnessInstances: new InMemoryHarnessInstanceRegistry(templates),
      datasets: new InMemoryDatasetRegistry(),
      benchmarks: new BenchmarkService({
        datasets: new InMemoryDatasetRegistry(),
        benchmarks: new InMemoryBenchmarkRegistry(),
      }),
    });
    const res = await svc.apply("acme", "u", parsed);
    expect(res.results.every((r) => r.status === "ok")).toBe(true); // codex 템플릿+인스턴스 + pinch 레시피 + 샘플 데이터셋
    expect([...new Set(res.results.map((r) => r.kind))].sort()).toEqual([
      "benchmark-recipe",
      "dataset",
      "harness",
      "harness-template",
    ]);
  });
});
