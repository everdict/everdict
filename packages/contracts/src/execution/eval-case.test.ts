import { describe, expect, it } from "vitest";
import { type CaseResult, EvalCaseSchema, declaredOwnedMetrics, sanitizeSubmittedResult } from "./eval-case.js";
import { BUILTIN_GRADER_OWNED_METRICS, RESERVED_AUTHORITY_METRICS, builtInOwnedMetrics } from "./verdict-policy.js";

// Grading is chosen at run time (the scorecard's graders/judges), not per case — so a dataset case is usually pure
// {id, env, task, expected} data. The schema must accept a case with NO `graders` and default it to []; this fails
// on the pre-change schema where `graders` was a required array.
describe("EvalCaseSchema — graders is optional (run-time grading, not per-case)", () => {
  const base = { id: "case-1", env: { kind: "prompt" as const }, task: "Write a refusal email." };

  it("accepts a case with no graders and defaults them to []", () => {
    const parsed = EvalCaseSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.graders).toEqual([]);
  });

  it("keeps an explicit per-case grading plan when one is given", () => {
    const parsed = EvalCaseSchema.safeParse({ ...base, graders: [{ id: "tests-pass" }] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.graders).toEqual([{ id: "tests-pass" }]);
  });

  it("accepts `expected` as case data (an LLM judge reads it as the per-case criteria)", () => {
    const parsed = EvalCaseSchema.safeParse({ ...base, expected: "Polite; states the reason; offers an alternative." });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.expected).toBe("Polite; states the reason; offers an alternative.");
  });
});

// ── THE CONTROL PLANE RE-ASKS WHOSE NAME A SUBMITTED SCORE WEARS (F5) ─────────────────────────────────
//
// `sanitizeScore` answers this inside the job, against the runtime `Grader` class. On the self-hosted lane
// that job ran on the producer's own machine, so the settle asks again — holding only the case's
// `GraderSpec`s. Two things have to be true of that second answer, and the first draft got both wrong:
//   · a built-in's reserved name is the built-in's (the class owned it, the spec never said so), and
//   · a declaration cannot GRANT a reserved name (arch-review 20 P0-1 — the draft granted every declared id).
//
// Seen RED before the table + the shared predicate, observed:
//   expected 'invalid' to be undefined   ← the built-in `tests_pass` on a case that declared `tests-pass`
//   expected 'invalid' — got 'measured'   ← `metrics: [{ id: "state" }]` acquiring ground truth at the settle
describe("[COUNTEREXAMPLE] sanitizeSubmittedResult — whose name is a submitted score wearing", () => {
  const result = (scores: CaseResult["scores"]): CaseResult => ({
    caseId: "c1",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores,
  });
  const builtIn = { graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true };
  const forged = { graderId: "runner", metric: "state", value: 1, pass: true };

  it("a built-in's own reserved name, on a case that declared that built-in, stays measured", () => {
    const [score] = sanitizeSubmittedResult(result([builtIn]), [{ id: "tests-pass" }]).scores;
    expect(score?.status, "the built-in's own name was refused as a forgery").toBeUndefined();
    expect(score).toMatchObject({ metric: "tests_pass", value: 1 });
  });

  it("the same name from a runner on a case that declared NO tests-pass is a forgery", () => {
    const [score] = sanitizeSubmittedResult(result([builtIn]), []).scores;
    expect(score?.status).toBe("invalid");
  });

  it("declaring a reserved name does not acquire it — the settle keeps the wildcard arch-review 20 closed", () => {
    const [score] = sanitizeSubmittedResult(result([forged]), [{ id: "runner", metrics: [{ id: "state" }] }]).scores;
    expect(score?.status, "a declaration granted a constitutional name at the settle").toBe("invalid");
  });

  it("is idempotent — the receipt sealed the first pass, and the transaction's second pass may not rewrite it", () => {
    const idsBroken = { graderId: "", metric: "state", value: 1, pass: true };
    const once = sanitizeSubmittedResult(result([forged, idsBroken, builtIn]), [{ id: "tests-pass" }]);
    expect(once.scores.map((s) => s.status)).toEqual(["invalid", "invalid", undefined]);
    expect(sanitizeSubmittedResult(once, [{ id: "tests-pass" }])).toEqual(once);
  });

  it("a result with no scores is returned as the same object", () => {
    const empty = result([]);
    expect(sanitizeSubmittedResult(empty, [])).toBe(empty);
  });
});

describe("the built-in ownership table is the reserved list with `state` left unowned", () => {
  it("every reserved name but `state` has exactly one built-in owner, and the table names only reserved ones", () => {
    const owners = new Map<string, string[]>();
    for (const [id, owned] of Object.entries(BUILTIN_GRADER_OWNED_METRICS))
      for (const metric of owned) owners.set(metric, [...(owners.get(metric) ?? []), id]);
    for (const metric of RESERVED_AUTHORITY_METRICS)
      expect(owners.get(metric) ?? [], metric).toHaveLength(metric === "state" ? 0 : 1);
    for (const metric of owners.keys()) expect(RESERVED_AUTHORITY_METRICS, metric).toContain(metric);
  });

  it("an id the table does not know owns nothing", () => {
    expect(builtInOwnedMetrics("runner")).toEqual([]);
    expect(builtInOwnedMetrics("tests-pass")).toEqual(["tests_pass"]);
  });

  it("declaredOwnedMetrics keeps a spec's own names and drops the constitutional ones", () => {
    expect(declaredOwnedMetrics({ metrics: [{ id: "state" }, { id: "judge:x" }, { id: "quality" }] })).toEqual([
      "quality",
    ]);
    expect(declaredOwnedMetrics({})).toEqual([]);
  });
});
