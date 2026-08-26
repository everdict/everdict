import type { GradeContext, Grader, Score } from "@everdict/contracts";
import { RESERVED_AUTHORITY_METRICS } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { safeGrade } from "./safe-grade.js";

// Trust suite (docs/trust-certification.md) — TRUST-78 · TRUST-79.
//
// AUTHORITY IS STAMPED BY A TRUSTED BOUNDARY; IT IS NEVER INFERRED FROM A PRODUCER-CONTROLLED LABEL.
//
// In this system a metric NAME assigns authority: the default ladder reads `state` and `tests_pass` as ground
// truth, and a custom grader is supposed to gain authority by DECLARING it on its spec — a declaration that is
// constitution-gated, because whoever can name new ground truth decides what passing MEANS.
//
// The gate was on the declaration and not on the name, and the name came from the producer: a custom script
// prints whatever `metric` it likes and the collector stamped only `graderId`. So the right to NAME ground
// truth and the right to be BELIEVED as ground truth had come apart, and the second one was ungated.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const CTX = {
  case: { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  observations: { kind: "unobserved", reason: "no_environment" },
} as unknown as GradeContext;

const emitting = (id: string, metric: string, extra: Partial<Grader> = {}): Grader => ({
  id,
  ...extra,
  grade: async (): Promise<Score> => ({ graderId: id, metric, value: 1, pass: true }),
});

describeTrust("TRUST-78 — an undeclared producer cannot name itself ground truth", () => {
  it("every reserved authority metric is refused to a grader that declared nothing", async () => {
    for (const metric of RESERVED_AUTHORITY_METRICS) {
      const [score] = await safeGrade(emitting("my-script", metric), CTX);
      // Invalid, not merely unmeasured: this is a producer CONTRACT violation, and the vocabulary matters —
      // an invalid row is visible on the plane, aggregated nowhere, and cannot decide a case.
      expect(score, `'${metric}' was accepted from an undeclared producer`).toMatchObject({
        status: "invalid",
        reason: "contract_violation",
      });
      expect(score?.detail).toContain(metric); // the author sees exactly what they emitted
    }
  });

  it("…and the producer that OWNS the name by construction is accepted verbatim", async () => {
    // The legitimate path, which must stay open or the guard is just a ban on a word. Ownership is intrinsic:
    // the built-in whose metric is fixed in its own code owns that name, and nothing in a spec can transfer it.
    const [score] = await safeGrade(emitting("tests-pass", "tests_pass", { ownsMetrics: ["tests_pass"] }), CTX);
    expect(score).toEqual({ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true });
  });

  it("TRUST-79 — a DECLARATION is not a wildcard: declaring one authority does not buy another's name", async () => {
    // The bypass this closes. `authority: "observational"` needs no admin, and the first version of the rule
    // only asked whether SOME authority had been declared — so an observational declaration bought `state`,
    // which the ladder reads as ground truth. A declaration authorizes the semantics of the producer's OWN
    // metric; it says nothing about labels that already carry authority.
    const [ground] = await safeGrade(emitting("my-script", "state", { ownsMetrics: ["my_score"] }), CTX);
    expect(ground).toMatchObject({ status: "invalid", reason: "contract_violation" });
    const [objective] = await safeGrade(emitting("my-script", "tests_pass", { ownsMetrics: ["my_score"] }), CTX);
    expect(objective).toMatchObject({ status: "invalid", reason: "contract_violation" });
  });

  it("TRUST-79 — a judge-verdict grant is the ONLY thing a spec may buy, and it buys nothing else", async () => {
    // Granting the inline judge's shapes is the code-judge wrapper's one legitimate need — the control plane
    // builds that wrapper, and the inner collection boundary sees only a CaseJob. It does NOT extend to the
    // reserved authority names, which is where the previous version's wildcard did its damage.
    const [own] = await safeGrade(emitting("code-judge", "judge", { ownsJudgeVerdict: true }), CTX);
    expect(own).toEqual({ graderId: "code-judge", metric: "judge", value: 1, pass: true });
    // Criteria are multi-segment by design (`judge:milestone:<id>` is a real code-judge shape).
    const [criterion] = await safeGrade(
      emitting("code-judge", "judge:milestone:login", { ownsJudgeVerdict: true }),
      CTX,
    );
    expect(criterion).toMatchObject({ metric: "judge:milestone:login", value: 1 });
    // …and the grant stops there: it is not a licence over ground truth.
    const [ground] = await safeGrade(emitting("code-judge", "state", { ownsJudgeVerdict: true }), CTX);
    expect(ground).toMatchObject({ status: "invalid", reason: "contract_violation" });
  });

  it("a grader cannot write into a registered judge's family, where a re-score could never replace it", async () => {
    // The compounding harm: judge ownership is the `judge:<id>` family, so a forged row is not merely a false
    // verdict — it is one that survives every later pass of the judge whose name it wears, because the strip
    // that replaces that judge's rows does not recognise a foreign producer's.
    const [score] = await safeGrade(emitting("my-script", "judge:quality"), CTX);
    expect(score).toMatchObject({ status: "invalid", reason: "contract_violation" });
  });

  it("an ordinary custom metric is untouched — the rule is about reserved names, not about custom graders", async () => {
    const [score] = await safeGrade(emitting("my-script", "my_score"), CTX);
    expect(score).toEqual({ graderId: "my-script", metric: "my_score", value: 1, pass: true });
  });
});
