import { describe, expect, it } from "vitest";
import { oracleTouched, pathMatchesPattern } from "./oracle-scope.js";

// The matcher is the one spelling of "did this change touch the exam" (code-evolution-loop.md, D3). Its
// language is small on purpose; each rule below is one the verdict relies on.
describe("pathMatchesPattern — the oracle scope's pattern language", () => {
  it("a bare path names itself, or a directory and everything beneath it", () => {
    expect(pathMatchesPattern("datasets/tb.json", "datasets/tb.json")).toBe(true);
    expect(pathMatchesPattern("datasets/tb.json", "datasets")).toBe(true);
    expect(pathMatchesPattern("datasets-v2/tb.json", "datasets")).toBe(false);
    expect(pathMatchesPattern("src/datasets/tb.json", "datasets")).toBe(false);
  });

  it("a trailing slash is the directory and its subtree; `**` crosses segments; `*` and `?` do not", () => {
    expect(pathMatchesPattern("tests/unit/deep/a.test.ts", "tests/")).toBe(true);
    expect(pathMatchesPattern("tests/unit/deep/a.test.ts", "tests/**")).toBe(true);
    expect(pathMatchesPattern("tests/a.test.ts", "tests/**/*.test.ts")).toBe(true);
    expect(pathMatchesPattern("tests/unit/a.test.ts", "tests/*.test.ts")).toBe(false);
    expect(pathMatchesPattern("judges/rubric-1.md", "judges/rubric-?.md")).toBe(true);
    expect(pathMatchesPattern("judges/rubric-10.md", "judges/rubric-?.md")).toBe(false);
    expect(pathMatchesPattern("a/b/c/eval.yaml", "**/eval.yaml")).toBe(true);
    expect(pathMatchesPattern("eval.yaml", "**/eval.yaml")).toBe(true);
  });

  it("ignores a leading ./ or / on either side, and escapes regex metacharacters in literals", () => {
    expect(pathMatchesPattern("./datasets/tb.json", "/datasets/")).toBe(true);
    expect(pathMatchesPattern("evals/a.b", "evals/a.b")).toBe(true);
    expect(pathMatchesPattern("evals/axb", "evals/a.b")).toBe(false);
    expect(pathMatchesPattern("anything", "")).toBe(false);
  });
});

describe("oracleTouched — what a change hit, sorted and unique", () => {
  it("returns the offending paths and nothing else", () => {
    const changed = [
      "src/scaffold/loop.ts",
      "tests/unit/loop.test.ts",
      "datasets/tb.json",
      "./tests/unit/loop.test.ts",
    ];
    expect(oracleTouched(changed, ["tests/", "datasets/**"])).toEqual(["datasets/tb.json", "tests/unit/loop.test.ts"]);
    expect(oracleTouched(changed, ["judges/"])).toEqual([]);
    expect(oracleTouched(changed, [])).toEqual([]);
  });
});
