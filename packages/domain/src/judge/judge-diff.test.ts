import { type JudgeSpec, JudgeSpecSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { diffJudgeSpecs } from "./judge-diff.js";

const model = (over: Record<string, unknown>): JudgeSpec =>
  JudgeSpecSchema.parse({
    kind: "model",
    id: "correctness",
    version: "1.0.0",
    provider: "anthropic",
    model: "claude-opus-4-8",
    rubric: "Does the answer solve the task?",
    inputs: ["trace"],
    passThreshold: 0.7,
    ...over,
  });

const harness = (over: Record<string, unknown>): JudgeSpec =>
  JudgeSpecSchema.parse({
    kind: "harness",
    id: "correctness",
    version: "1.0.0",
    harness: { id: "claude-code", version: "latest" },
    ...over,
  });

describe("diffJudgeSpecs", () => {
  it("reports no changes for identical specs (only version differs)", () => {
    const diff = diffJudgeSpecs(model({ version: "1.0.0" }), model({ version: "1.1.0" }));
    expect(diff).toMatchObject({
      id: "correctness",
      base: "1.0.0",
      candidate: "1.1.0",
      kindChanged: false,
      changes: [],
      summary: { added: 0, removed: 0, changed: 0 },
    });
  });

  it("reports model / provider / threshold changes as leaf paths", () => {
    const diff = diffJudgeSpecs(
      model({ version: "1.0.0" }),
      model({ version: "1.1.0", provider: "openai", model: "gpt-5.4-mini", passThreshold: 0.8 }),
    );
    expect(diff.changes).toEqual([
      { path: "model", before: "claude-opus-4-8", after: "gpt-5.4-mini", change: "changed" },
      { path: "passThreshold", before: "0.7", after: "0.8", change: "changed" },
      { path: "provider", before: "anthropic", after: "openai", change: "changed" },
    ]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 3 });
  });

  it("labels a field present only in candidate as added, only in base as removed", () => {
    const added = diffJudgeSpecs(model({}), model({ version: "1.1.0", description: "stricter" }));
    expect(added.changes).toEqual([{ path: "description", before: "(none)", after: "stricter", change: "added" }]);
    expect(added.summary).toEqual({ added: 1, removed: 0, changed: 0 });

    const removed = diffJudgeSpecs(model({ description: "stricter" }), model({ version: "1.1.0" }));
    expect(removed.changes).toEqual([{ path: "description", before: "stricter", after: "(none)", change: "removed" }]);
    expect(removed.summary).toEqual({ added: 0, removed: 1, changed: 0 });
  });

  it("surfaces a rubric text change as a leaf path", () => {
    const diff = diffJudgeSpecs(
      model({ rubric: "old rubric" }),
      model({ version: "1.1.0", rubric: "new rubric" }),
    );
    expect(diff.changes).toContainEqual({
      path: "rubric",
      before: "old rubric",
      after: "new rubric",
      change: "changed",
    });
  });

  it("flags kindChanged when the judge kind differs (model ↔ harness) and reports kind as a change", () => {
    const diff = diffJudgeSpecs(model({ version: "1.0.0" }), harness({ version: "2.0.0" }));
    expect(diff.kindChanged).toBe(true);
    expect(diff.changes.some((c) => c.path === "kind")).toBe(true);
  });
});
