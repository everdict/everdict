import type { CaseJob, CaseResult, EvalCase, Score, VerifierJob } from "@everdict/contracts";
import { caseJobPayload } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { withVerifierPass } from "./verifier-pass.js";

// ── A SPLIT CASE STILL RUNS (arch-review 56, Wave K) ─────────────────────────────────────────────────
//
// Wave B made `caseJobPayload` refuse a case whose grading depends on material the agent must not see, and
// that refusal is currently a REGRESSION: `terminal-bench.ts` puts a task's hidden `tests/` bytes and its
// verifier env in the grader config, and it always did, so every Terminal-Bench task with tests stopped
// dispatching on the managed lanes. Fail-closed was the right first move — a benchmark that leaks its answer
// key produces no scores worth having — but a refusal is not where this ends.
//
// Wave H split the case (`verifierPlanOf`) and Wave I gave the judging half a runner (`runVerifierJob`).
// This is the seam that uses them: the agent gets the remainder, the verdict comes back from a second unit,
// and the two sets of scores are one CaseResult.
//
//     dispatch(remainder)                    → CaseResult{ snapshot, scores: [observation…] }
//       → dispatchVerifier({ plan, snapshot }) → [ tests_pass, reward:… ]
//         → CaseResult{ scores: [observation…, tests_pass, reward:…] }
//
// WHAT THIS PINS, in order of what would silently go wrong:
//   · the agent's job is the REMAINDER — if the split is skipped the payload refuses, which is the whole
//     point of Wave B being a refusal rather than a strip;
//   · a case with no private material does NOT pay for a second dispatch;
//   · the verifier's scores REACH the result — a pass that ran and was dropped is worse than one that never
//     ran, because the record then says the case was measured;
//   · a verifier that could not run does NOT leave the case looking measured.

const privateCase = (): EvalCase =>
  ({
    id: "c1",
    task: "make the tests pass",
    env: { kind: "repo", source: { path: "/app" } },
    image: "tasks/repro:1",
    graders: [
      { id: "reward-file", config: { cmd: "bash /tests/test.sh", files: { "test.sh": "assert_it()" } } },
      { id: "steps" },
    ],
  }) as unknown as EvalCase;

const openCase = (): EvalCase =>
  ({
    id: "c2",
    task: "do the thing",
    env: { kind: "repo", source: { path: "/app" } },
    graders: [{ id: "tests-pass", config: { cmd: "pytest" } }],
  }) as unknown as EvalCase;

const jobFor = (evalCase: EvalCase): CaseJob =>
  ({ runId: "r1", tenant: "acme", evalCase, harness: { id: "h", version: "1" } }) as unknown as CaseJob;

const agentResult = (): CaseResult =>
  ({
    caseId: "c1",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "repo", diff: "d", changedFiles: ["a"], headSha: "sha" },
    scores: [{ graderId: "steps", metric: "steps", value: 3 }],
  }) as unknown as CaseResult;

const VERDICT: Score[] = [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true } as Score];

// RED as of a09cf2c3, observed:
//   Cannot find module './verifier-pass.js'
describe("[R56 WAVE-K COUNTEREXAMPLE #11 — CLOSED] a case whose verdict is private still runs", () => {
  it("dispatches the agent a case its lane will accept, and judges in a second unit", async () => {
    const dispatched: CaseJob[] = [];
    const verified: VerifierJob[] = [];

    const result = await withVerifierPass(jobFor(privateCase()), {
      dispatch: async (job) => {
        dispatched.push(job);
        // The lane's own rule, asserted where it bites: an unsplit case throws here.
        caseJobPayload(job);
        return agentResult();
      },
      dispatchVerifier: async (job) => {
        verified.push(job);
        return VERDICT;
      },
    });

    // The agent got the work and none of the verdict.
    const shipped = JSON.stringify(dispatched[0]);
    expect(shipped, "the hidden tests rode to the agent's lane").not.toContain("assert_it");
    expect(shipped).toContain("make the tests pass");

    // …and a second unit judged it, from the workspace the agent left.
    expect(verified, "no verifier job was dispatched, so the case has no verdict at all").toHaveLength(1);
    expect(verified[0]?.plan.graders.map((g) => g.id)).toEqual(["reward-file"]);
    expect(verified[0]?.workspace).toEqual(agentResult().snapshot);

    // …and BOTH halves are in the result. A verdict that ran and was dropped is worse than one that never
    // ran: the record would say the case was measured.
    expect(result.scores.map((s) => s.metric).sort()).toEqual(["steps", "tests_pass"]);
  });

  it("does not pay for a second dispatch when nothing is private", async () => {
    let verifierCalls = 0;
    const result = await withVerifierPass(jobFor(openCase()), {
      dispatch: async () => ({ ...agentResult(), caseId: "c2" }) as CaseResult,
      dispatchVerifier: async () => {
        verifierCalls += 1;
        return VERDICT;
      },
    });
    expect(verifierCalls, "an ordinary case was charged a verifier unit it does not need").toBe(0);
    expect(result.scores.map((s) => s.metric)).toEqual(["steps"]);
  });

  it("does not leave the case looking measured when the verifier could not run", async () => {
    // The verdict is the case's whole point. A dispatch failure here must not resolve into a CaseResult whose
    // scores are the observation-only ones — that reads downstream as "this case was graded and scored 0
    // nothing", which is the `unmeasured` distinction the reward-file grader exists to preserve.
    const result = await withVerifierPass(jobFor(privateCase()), {
      dispatch: async () => agentResult(),
      dispatchVerifier: async () => {
        throw new Error("verifier lane unreachable");
      },
    });

    const verdict = result.scores.find((s) => s.metric === "tests_pass");
    expect(verdict, "the verifier's failure left no trace on the case").toBeDefined();
    expect(verdict !== undefined && "status" in verdict ? verdict.status : undefined).toBe("unmeasured");
    expect(verdict !== undefined && "value" in verdict ? verdict.value : undefined).toBeUndefined();
  });

  it("does not judge a case whose environment left no workspace to judge", async () => {
    // A prompt or browser case has no file tree to reconstitute. Dispatching a verifier for it would provision
    // a container, restore nothing, and score the empty image — a number the benchmark never produced.
    let verifierCalls = 0;
    const result = await withVerifierPass(jobFor(privateCase()), {
      dispatch: async () => ({ ...agentResult(), snapshot: { kind: "prompt", output: "hi" } }) as unknown as CaseResult,
      dispatchVerifier: async () => {
        verifierCalls += 1;
        return VERDICT;
      },
    });
    expect(verifierCalls).toBe(0);
    const verdict = result.scores.find((s) => s.metric === "tests_pass");
    expect(verdict !== undefined && "status" in verdict ? verdict.status : undefined).toBe("unmeasured");
  });
});
