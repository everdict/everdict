import { describe, expect, it } from "vitest";
// The parser ships INSIDE the action (examples/github-action/run-eval — plain ESM, zero-dep); the test lives here
// because examples/ has no test runner of its own. The .d.ts sibling gives it a typed surface.
import { parseEvaluateArgs } from "../../../../examples/github-action/run-eval/parse-evaluate-args.mjs";

describe("/evaluate comment argument parsing (run-eval action)", () => {
  it("maps key=value tokens onto the scorecard submit overrides", () => {
    const { overrides, warnings } = parseEvaluateArgs(
      "/evaluate limit=20 tags=smoke,fast trials=3 runtime=self:ws sink=none retries=2 concurrency=8",
    );
    expect(overrides).toEqual({
      cases: { limit: 20, tags: ["smoke", "fast"] },
      trials: 3,
      runtime: "self:ws",
      traceSink: "none",
      retries: 2,
      concurrency: 8,
    });
    expect(warnings).toEqual([]);
  });

  it("a bare /evaluate (no args) changes nothing — the workflow inputs stay authoritative", () => {
    expect(parseEvaluateArgs("/evaluate")).toEqual({ overrides: {}, warnings: [] });
    expect(parseEvaluateArgs("/evaluate   ")).toEqual({ overrides: {}, warnings: [] });
  });

  it("malformed and unknown tokens become warnings, never failures — a typo must not cost the fire", () => {
    const { overrides, warnings } = parseEvaluateArgs("/evaluate bogus foo=bar limit=abc concurrency=0 trials=2");
    expect(overrides).toEqual({ trials: 2 }); // the valid token still applies
    expect(warnings).toEqual([
      "ignored 'bogus' (expected key=value)",
      "ignored unknown key 'foo'",
      "ignored limit='abc' (positive integer required)",
      "ignored concurrency='0' (positive integer required)",
    ]);
  });

  it("non-/evaluate bodies are inert (the workflow gate is the real filter; this is defense in depth)", () => {
    expect(parseEvaluateArgs("looks good to me!")).toEqual({ overrides: {}, warnings: [] });
    expect(parseEvaluateArgs(undefined)).toEqual({ overrides: {}, warnings: [] });
  });

  it("ids selection + retries bounds", () => {
    expect(parseEvaluateArgs("/evaluate ids=c1,c2").overrides).toEqual({ cases: { ids: ["c1", "c2"] } });
    expect(parseEvaluateArgs("/evaluate retries=9").warnings).toEqual(["ignored retries='9' (0–5)"]);
  });
});
