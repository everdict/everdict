import { describe, expect, it } from "vitest";
import { JudgeSpecSchema } from "./judge-spec.js";

const base = { kind: "model", id: "j", version: "1.0.0", model: "claude-opus-4-8", rubric: "correct?" };

describe("JudgeSpecSchema — promptTemplate/criteria validated at the boundary (registration-time)", () => {
  it("accepts a spec without promptTemplate/criteria (back-compat)", () => {
    const parsed = JudgeSpecSchema.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  it("rejects a promptTemplate without {verdict_instruction} — it would break verdict parsing at grading time", () => {
    const parsed = JudgeSpecSchema.safeParse({ ...base, promptTemplate: "Judge {task} against {rubric}." });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("{verdict_instruction}");
    }
  });

  it("accepts a promptTemplate carrying {verdict_instruction}", () => {
    const parsed = JudgeSpecSchema.safeParse({
      ...base,
      promptTemplate: "Judge {task} against {rubric}.\n{verdict_instruction}",
    });
    expect(parsed.success).toBe(true);
  });

  it("applies criterion defaults (weight 1) and keeps unique ids", () => {
    const parsed = JudgeSpecSchema.safeParse({
      ...base,
      criteria: [{ id: "accuracy", description: "is it right" }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind !== "code") {
      expect(parsed.data.criteria?.[0]).toEqual({ id: "accuracy", description: "is it right", weight: 1 });
    }
  });

  it("code judge: requires code or entrypoint; defaults timeoutSec", () => {
    const code = { kind: "code", id: "e2e", version: "1.0.0", language: "python" };
    expect(JudgeSpecSchema.safeParse(code).success).toBe(false); // neither code nor entrypoint
    const parsed = JudgeSpecSchema.safeParse({ ...code, code: "print('[]')" });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === "code") {
      expect(parsed.data.timeoutSec).toBe(600);
    }
    expect(JudgeSpecSchema.safeParse({ ...code, entrypoint: "judge.py", image: "ghcr.io/x/judge:1" }).success).toBe(
      true,
    );
  });

  it("rejects duplicate criterion ids (each becomes a metric suffix)", () => {
    const parsed = JudgeSpecSchema.safeParse({
      ...base,
      criteria: [
        { id: "accuracy", description: "a" },
        { id: "accuracy", description: "b" },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("harness judges take the same prompt fields", () => {
    const parsed = JudgeSpecSchema.safeParse({
      kind: "harness",
      id: "reviewer",
      version: "1.0.0",
      harness: { id: "claude-code", version: "latest" },
      promptTemplate: "Review.\n{verdict_instruction}",
      criteria: [{ id: "safety", description: "is it safe" }],
    });
    expect(parsed.success).toBe(true);
  });
});
