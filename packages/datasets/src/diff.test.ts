import { type Dataset, DatasetSchema } from "@assay/core";
import { describe, expect, it } from "vitest";
import { diffDatasets } from "./diff.js";

// 최소 케이스 빌더 — repo env + steps grader. overrides 로 task/graders 등을 바꿔 변경 케이스를 만든다.
function ds(version: string, cases: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Dataset {
  return DatasetSchema.parse({
    id: "browser-llm",
    version,
    cases: cases.map((c) => ({
      env: { kind: "repo", source: { files: {} } },
      task: "do x",
      graders: [{ id: "steps" }],
      ...c,
    })),
    ...extra,
  });
}

describe("diffDatasets (버전 간 데이터셋 diff)", () => {
  it("candidate 에만 있는 케이스는 added, base 에만 있는 케이스는 removed 로 분류한다", () => {
    const base = ds("1.0.0", [{ id: "a" }, { id: "b" }]);
    const cand = ds("1.1.0", [{ id: "a" }, { id: "c" }]);

    const d = diffDatasets(base, cand);

    expect(d.base).toBe("1.0.0");
    expect(d.candidate).toBe("1.1.0");
    expect(d.added.map((x) => x.id)).toEqual(["c"]);
    expect(d.removed.map((x) => x.id)).toEqual(["b"]);
    expect(d.unchanged).toBe(1); // a
    expect(d.summary).toEqual({ added: 1, removed: 1, changed: 0, unchanged: 1 });
  });

  it("같은 id 의 케이스가 task/graders 가 다르면 changed + 어떤 필드가 달라졌는지 보고한다", () => {
    const base = ds("1.0.0", [{ id: "a", task: "old task", graders: [{ id: "steps" }] }]);
    const cand = ds("1.1.0", [{ id: "a", task: "new task", graders: [{ id: "steps" }, { id: "cost" }] }]);

    const d = diffDatasets(base, cand);

    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toHaveLength(1);
    const change = d.changed[0];
    expect(change?.id).toBe("a");
    const fields = change?.changes.map((c) => c.field) ?? [];
    expect(fields).toContain("task");
    expect(fields).toContain("graders");
    const taskChange = change?.changes.find((c) => c.field === "task");
    expect(taskChange).toEqual({ field: "task", before: "old task", after: "new task" });
  });

  it("내용이 동일한 케이스는 unchanged 로만 집계하고 changed 에 넣지 않는다(키 순서 무관)", () => {
    const base = ds("1.0.0", [{ id: "a", graders: [{ id: "steps" }, { id: "cost" }] }]);
    const cand = ds("1.1.0", [{ id: "a", graders: [{ id: "steps" }, { id: "cost" }] }]);

    const d = diffDatasets(base, cand);

    expect(d.changed).toEqual([]);
    expect(d.unchanged).toBe(1);
  });

  it("데이터셋 메타(description/tags) 변경을 meta 로 보고한다", () => {
    const base = ds("1.0.0", [{ id: "a" }], { description: "v1", tags: ["x"] });
    const cand = ds("1.1.0", [{ id: "a" }], { description: "v2", tags: ["x", "y"] });

    const d = diffDatasets(base, cand);

    const metaFields = d.meta.map((m) => m.field);
    expect(metaFields).toContain("description");
    expect(metaFields).toContain("tags");
    expect(d.meta.find((m) => m.field === "description")).toEqual({
      field: "description",
      before: "v1",
      after: "v2",
    });
  });
});
