import type { CaseResult, Scorecard, TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { scorecardModels } from "./models.js";

// Only llm_call events contribute to the model axis. One case can have multiple calls (mixed models).
const llm = (model: string): TraceEvent => ({ t: 0, kind: "llm_call", model });
const result = (caseId: string, models: string[]): CaseResult => ({
  caseId,
  harness: "h@1",
  trace: models.map(llm),
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
});
const sc = (results: CaseResult[]): Scorecard => ({ suiteId: "d", harness: "h@1", results });

describe("scorecardModels", () => {
  it("gathers observed models from the trace as distinct·sorted and takes the mode as primary", () => {
    const m = scorecardModels(sc([result("c1", ["claude-opus-4-8", "claude-opus-4-8"]), result("c2", ["gpt-4"])]));
    expect(m.observed).toEqual(["claude-opus-4-8", "gpt-4"]); // sorted·deduplicated
    expect(m.primary).toBe("claude-opus-4-8"); // observed twice > once
    expect(m.declared).toBeUndefined();
  });

  it("on a tie, the lexicographically first value is primary (deterministic)", () => {
    const m = scorecardModels(sc([result("c1", ["b-model"]), result("c2", ["a-model"])]));
    expect(m.primary).toBe("a-model");
  });

  it("when there's an observation, it takes precedence over declared (primary=observed) — preserves declared≠actual drift", () => {
    const m = scorecardModels(sc([result("c1", ["gpt-4o"])]), "gpt-4");
    expect(m.observed).toEqual(["gpt-4o"]);
    expect(m.declared).toBe("gpt-4");
    expect(m.primary).toBe("gpt-4o");
  });

  it("with no observation, falls back to declared as primary (e.g. a harness with no model in the trace)", () => {
    const m = scorecardModels(sc([result("c1", [])]), "claude-sonnet-4-6");
    expect(m.observed).toEqual([]);
    expect(m.primary).toBe("claude-sonnet-4-6");
  });

  it("with neither observation nor declaration, primary is unset (unknown)", () => {
    const m = scorecardModels(sc([result("c1", [])]));
    expect(m.observed).toEqual([]);
    expect(m.primary).toBeUndefined();
    expect(m.declared).toBeUndefined();
  });

  it("ignores empty model strings (a synthetic usage proxy may emit an empty value)", () => {
    const m = scorecardModels(sc([result("c1", ["", "gpt-4"])]), "");
    expect(m.observed).toEqual(["gpt-4"]);
    expect(m.primary).toBe("gpt-4");
    expect(m.declared).toBeUndefined();
  });
});
