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
    const [score] = sanitizeSubmittedResult(result([builtIn]), { graders: [{ id: "tests-pass" }], judges: [] }).scores;
    expect(score?.status, "the built-in's own name was refused as a forgery").toBeUndefined();
    expect(score).toMatchObject({ metric: "tests_pass", value: 1 });
  });

  it("the same name from a runner on a case that declared NO tests-pass is a forgery", () => {
    const [score] = sanitizeSubmittedResult(result([builtIn]), { graders: [], judges: [] }).scores;
    expect(score?.status).toBe("invalid");
  });

  it("declaring a reserved name does not acquire it — the settle keeps the wildcard arch-review 20 closed", () => {
    const [score] = sanitizeSubmittedResult(result([forged]), {
      graders: [{ id: "runner", metrics: [{ id: "state" }] }],
      judges: [],
    }).scores;
    expect(score?.status, "a declaration granted a constitutional name at the settle").toBe("invalid");
  });

  it("is idempotent — the receipt sealed the first pass, and the transaction's second pass may not rewrite it", () => {
    const idsBroken = { graderId: "", metric: "state", value: 1, pass: true };
    const once = sanitizeSubmittedResult(result([forged, idsBroken, builtIn]), {
      graders: [{ id: "tests-pass" }],
      judges: [],
    });
    expect(once.scores.map((s) => s.status)).toEqual(["invalid", "invalid", undefined]);
    expect(sanitizeSubmittedResult(once, { graders: [{ id: "tests-pass" }], judges: [] })).toEqual(once);
  });

  it("a result with no scores is returned as the same object", () => {
    const empty = result([]);
    expect(sanitizeSubmittedResult(empty, { graders: [], judges: [] })).toBe(empty);
  });

  // ── THE JUDGE FAMILY: three producers a declaration can name, and nothing else ──────────────────────
  //
  // Seen RED while the settle still wrote `ownsJudgeVerdict: true` for every producer, observed:
  //   expected undefined to be 'invalid'   ← a runner's `judge:gpt-4` on a case with no such judge, kept
  const forgedVerdict = { graderId: "runner", metric: "judge:gpt-4", value: 1, pass: true };

  it("a runner's judge-family row on a case with no such judge and no inline judge is a forgery", () => {
    const [score] = sanitizeSubmittedResult(result([forgedVerdict]), { graders: [], judges: [] }).scores;
    expect(score?.status, "a producer wrote a verdict nobody asked for").toBe("invalid");
  });

  it("the platform's own judge rows — verdict, criterion and the coverage row — are the platform's", () => {
    const rows = [
      { graderId: "gpt-4", metric: "judge:gpt-4", value: 1, pass: true },
      { graderId: "gpt-4", metric: "judge:gpt-4:accuracy", value: 1, pass: true },
      {
        graderId: "claude",
        metric: "judge:claude",
        status: "unmeasured" as const,
        reason: "grader_error" as const,
        retryable: true,
      },
    ];
    const out = sanitizeSubmittedResult(result(rows), { graders: [], judges: [{ id: "gpt-4" }, { id: "claude" }] });
    expect(out.scores.map((s) => s.status)).toEqual([undefined, undefined, "unmeasured"]);
  });

  it("…but a judge that merely shares a prefix with a selected one is not it", () => {
    const [score] = sanitizeSubmittedResult(result([{ ...forgedVerdict, metric: "judge:gpt-4o" }]), {
      graders: [],
      judges: [{ id: "gpt-4" }],
    }).scores;
    expect(score?.status).toBe("invalid");
  });

  it("an inline judge the case declared owns the family, as does a spec declaring judge authority under its configured id", () => {
    const inline = { graderId: "judge", metric: "judge", value: 1, pass: true };
    const wrapped = { graderId: "code-judge", metric: "judge:code-judge", value: 1, pass: true };
    const out = sanitizeSubmittedResult(result([inline, wrapped]), {
      graders: [{ id: "judge" }, { id: "script", config: { id: "code-judge", cmd: "true" }, authority: "judge" }],
      judges: [],
    });
    expect(out.scores.map((s) => s.status)).toEqual([undefined, undefined]);
  });
});

describe("the built-in ownership table covers the reserved list", () => {
  // ⚠️ This used to assert EXACTLY one owner per reserved name, which described the table rather than
  // defending anything: the settle asks `builtInOwnedMetrics(id).includes(metric)`, a question two owners
  // answer as well as one, and nothing downstream is protected by the count (a case can already carry two
  // `tests-pass` graders and produce two ground-truth scores).
  //
  // It is also false of the domain. `tests_pass` means "the task's own tests passed", and TWO first-party
  // graders produce exactly that fact: `tests-pass` runs a command, and `reward-file` runs a container task's
  // own verifier and reads the reward it PUBLISHES. The bijection is what left `reward-file` out of the table
  // while its class claimed the name, so every container-task verdict settled `invalid`.
  //
  // What matters, and what is asserted: every reserved name has an owner — `state` included, since `state-check` produces it by construction now, and the
  // table never grants a name outside the reserved list.
  it("every reserved name has a built-in owner, and the table names only reserved ones", () => {
    const owners = new Map<string, string[]>();
    for (const [id, owned] of Object.entries(BUILTIN_GRADER_OWNED_METRICS))
      for (const metric of owned) owners.set(metric, [...(owners.get(metric) ?? []), id]);
    for (const metric of RESERVED_AUTHORITY_METRICS) expect(owners.get(metric) ?? [], metric).not.toHaveLength(0);
    // Two "did the task's tests pass" readers, one state verifier — the first draft listed one owner of
    // `tests_pass` and none of `state`, and every reward-file case would have lost its verdict at the settle.
    expect(owners.get("tests_pass")?.sort()).toEqual(["reward-file", "tests-pass"]);
    expect(owners.get("state")).toEqual(["state-check"]);
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
