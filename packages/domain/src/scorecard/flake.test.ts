import type { CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { flakeIndex } from "./flake.js";

const scored = (caseId: string, pass: boolean): CaseResult => ({
  caseId,
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "done" },
  scores: [{ graderId: "t", metric: "tests_pass", value: pass ? 1 : 0, pass }],
});

const record = (results: CaseResult[], runtime?: string) => ({
  harness: { id: "h", version: "1" },
  ...(runtime !== undefined ? { runtime } : {}),
  scorecard: { suiteId: "d@1", harness: "h@1", results },
});

describe("flakeIndex — the cross-batch flake sentence, made refutable", () => {
  it("a case that flips verdicts across batches under the same key is flaky; stable and one-shot keys are not", () => {
    const idx = flakeIndex([
      record([scored("flip", true), scored("stable", true), scored("once", true)]),
      record([scored("flip", false), scored("stable", true)]),
      record([scored("flip", true), scored("stable", true)]),
    ]);
    expect(idx.observedKeys).toBe(2); // flip + stable ("once" has a single observation)
    expect(idx.entries).toHaveLength(1);
    expect(idx.entries[0]).toMatchObject({ caseId: "flip", observations: 3, passes: 2, failures: 1 });
    expect(idx.entries[0]?.flakeScore).toBeCloseTo((1 / 3) * 2);
  });

  it("a different runtime is a different key — platform flake never blends into agent flake", () => {
    const idx = flakeIndex([
      record([scored("a", true)], "nomad"),
      record([scored("a", false)], "k8s"),
      record([scored("a", true)], "nomad"),
    ]);
    // nomad saw pass/pass (stable); k8s saw one observation — nothing flaky.
    expect(idx.entries).toHaveLength(0);
  });

  it("an unverdicted case (infra death, unmeasured-only) is no observation at all — an outage is not a flake", () => {
    const dead: CaseResult = {
      caseId: "a",
      harness: "h@1",
      trace: [],
      snapshot: { kind: "prompt", output: "" },
      scores: [],
      failure: { stage: "dispatch", class: "infra", code: "UPSTREAM_ERROR", message: "blip", retryable: true },
    };
    const idx = flakeIndex([record([scored("a", true)]), record([dead]), record([scored("a", true)])]);
    expect(idx.entries).toHaveLength(0);
    expect(idx.observedKeys).toBe(1); // two REAL observations, both passes
  });
});
