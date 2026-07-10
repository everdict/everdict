import { type Dataset, DatasetSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { diffDatasets } from "./diff.js";

// Minimal case builder — repo env + steps grader. Override task/graders etc. to make a changed case.
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

describe("diffDatasets (dataset diff across versions)", () => {
  it("classifies cases only in candidate as added and cases only in base as removed", () => {
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

  it("reports a case with the same id as changed + which fields differ when task/graders differ", () => {
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

  it("counts identical-content cases only as unchanged and doesn't put them in changed (key order independent)", () => {
    const base = ds("1.0.0", [{ id: "a", graders: [{ id: "steps" }, { id: "cost" }] }]);
    const cand = ds("1.1.0", [{ id: "a", graders: [{ id: "steps" }, { id: "cost" }] }]);

    const d = diffDatasets(base, cand);

    expect(d.changed).toEqual([]);
    expect(d.unchanged).toBe(1);
  });

  it("reports dataset meta (description/tags) changes as meta", () => {
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
