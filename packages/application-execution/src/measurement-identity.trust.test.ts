import type { GradeContext, Grader, GraderSpec, Score } from "@everdict/contracts";
import { DEFAULT_VERDICT_POLICY, composeVerdictPolicy } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { safeGrade } from "./safe-grade.js";

// Trust suite (docs/trust-certification.md) — TRUST-101.
//
// WHAT A GRADER IS AND WHAT IT MEASURES ARE DIFFERENT NAMES.
//
// `GraderSpec.id` selects the implementation (`script`, `command`, `judge`…) and, through `authority`, also
// named the metric those semantics applied to. Those coincide only for graders whose metric happens to equal
// their type. A script grader is declared `id: "script"` with `config.id: "business-check"` and prints
// `metric: "quality"` — so the declaration composed a policy rule about the metric `"script"`, which nothing
// emits, while the score that actually landed carried no declared semantics at all.
//
// Not a privilege escalation — the opposite: a declaration that describes nothing. But an identity model where
// the declared name and the produced name can differ is one where every later rule about either is guesswork,
// and a custom-grader ecosystem makes that worse every time it grows.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const CTX = {
  case: { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
  trace: [],
  snapshot: { kind: "prompt", output: "" },
} as unknown as GradeContext;

const matchedMetrics = (specs: GraderSpec[]): string[] =>
  composeVerdictPolicy(specs)
    .metrics.filter((m) => !DEFAULT_VERDICT_POLICY.metrics.includes(m))
    .map((m) => ("metric" in m.match ? m.match.metric : "(prefix)"));

describeTrust("TRUST-101 — a grader declares the semantics of what it MEASURES", () => {
  it("declared metrics compose rules about those names, not about the implementation's name", () => {
    const spec: GraderSpec = {
      id: "script",
      config: { id: "business-check" },
      metrics: [{ id: "quality", authority: "objective" }],
    };
    expect(matchedMetrics([spec])).toEqual(["quality"]);
  });

  it("…and the id-based reading still applies when no metrics are named — every existing dataset keeps its meaning", () => {
    expect(matchedMetrics([{ id: "my_score", authority: "objective" }])).toEqual(["my_score"]);
  });

  it("naming metrics REPLACES the id reading — a spec that names them is not also claiming its type is one", () => {
    const spec: GraderSpec = {
      id: "script",
      authority: "objective",
      metrics: [{ id: "quality", authority: "objective" }],
    };
    expect(matchedMetrics([spec])).toEqual(["quality"]); // not ["script", "quality"]
  });

  it("a declared metric may be EMITTED by its own producer — the two halves of one declaration agree", async () => {
    // Otherwise a grader declaring `metrics: [{id:"state", authority:"ground_truth"}]` would compose the rule
    // and then have its own score invalidated for emitting the name it just declared.
    const grader: Grader = {
      id: "my-check",
      ownsMetrics: ["state"],
      grade: async (): Promise<Score> => ({ graderId: "my-check", metric: "state", value: 1, pass: true }),
    };
    expect(await safeGrade(grader, CTX)).toEqual([{ graderId: "my-check", metric: "state", value: 1, pass: true }]);
  });

  it("…and a producer that declared nothing still may not emit it", async () => {
    const grader: Grader = {
      id: "my-check",
      grade: async (): Promise<Score> => ({ graderId: "my-check", metric: "state", value: 1, pass: true }),
    };
    expect((await safeGrade(grader, CTX))[0]).toMatchObject({ status: "invalid", reason: "contract_violation" });
  });
});
