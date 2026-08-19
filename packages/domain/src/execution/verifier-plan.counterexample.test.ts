import type { CaseJob, EvalCase } from "@everdict/contracts";
import { caseJobPayload, verifierPrivateMaterial } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { verifierPlanOf } from "./verifier-plan.js";

// ── A CASE SPLITS INTO WHAT THE AGENT DOES AND HOW IT IS JUDGED (arch-review 56, Wave H) ─────────────
//
// Wave B closed the disclosure by REFUSING: a case whose grading depends on material the agent must not see
// cannot be measured on a lane that runs the agent and the verifier in one environment, so `caseJobPayload`
// throws rather than shipping the hidden tests inside `EVERDICT_CASE_JOB`. That is correct and it is a
// refusal — the benchmark still cannot run.
//
// What lifts it is separation, not another guard. The case job carries what the agent needs to DO the work;
// the verifier plan carries what decides whether it did. They travel to different containers, so no ordering
// discipline is load-bearing:
//
//     case job                        verifier job
//     ─────────────                   ─────────────
//     instruction, env, harness       the frozen workspace, read-only
//     (no tests, no verifier env)     + the hidden tests
//                                     + a fresh reward volume
//                                     → reward bytes
//
// This is the CONTRACT half: one function that splits a case into the two, and the property that the agent's
// half cannot be reconstructed into the verifier's. The dispatch half (a second job, the snapshot transport)
// builds on it — and cannot be built safely without it, because a split done at the dispatcher is a split
// every future dispatcher has to remember.

const privateCase = (): EvalCase =>
  ({
    id: "c1",
    task: "make the tests pass",
    env: { kind: "repo", source: { path: "/app" } },
    image: "tasks/repro:1",
    graders: [
      {
        id: "reward-file",
        config: {
          cmd: "bash /tests/test.sh",
          files: { "test.sh": "assert_solution()" },
          env: { OPENAI_API_KEY: "sk-real" },
          timeoutSec: 300,
        },
      },
      { id: "steps" },
    ],
  }) as unknown as EvalCase;

const jobFor = (evalCase: EvalCase): CaseJob =>
  ({ runId: "r1", tenant: "acme", evalCase, harness: { id: "h", version: "1" } }) as unknown as CaseJob;

// RED as of 783f4869, observed:
//   verifierPlanOf is not a function
describe("[R56 WAVE-H COUNTEREXAMPLE #9 — CLOSED] a case separates its work from its verdict", () => {
  it("puts every private grader in the plan and leaves none on the agent's job", () => {
    const plan = verifierPlanOf(privateCase());

    expect(
      plan?.graders.map((g) => g.id),
      "the verifier's own grader is not in the plan",
    ).toEqual(["reward-file"]);
    // The bytes and the credential are the plan's, and the plan is not part of what a backend serializes.
    expect(JSON.stringify(plan)).toContain("assert_solution");
    expect(JSON.stringify(plan)).toContain("sk-real");
  });

  it("leaves the agent a case it can still work on, with nothing that decides the verdict", () => {
    const agentCase = verifierPlanOf(privateCase())?.remainder;
    const shipped = JSON.stringify(agentCase);

    expect(shipped, "the hidden tests rode along to the agent").not.toContain("assert_solution");
    expect(shipped, "the verifier's credential rode along to the agent").not.toContain("sk-real");
    // …and the work itself is intact: the instruction, the environment, the image, and the graders that
    // observe rather than decide.
    expect(shipped).toContain("make the tests pass");
    expect(shipped).toContain("tasks/repro:1");
    expect(agentCase?.graders?.map((g) => g.id)).toEqual(["steps"]);
  });

  it("makes the split the ONLY way such a case ships — the remainder passes the payload guard", () => {
    // The join of the two waves: Wave B refuses a case carrying private material, and this is what a lane
    // hands it instead. If the remainder still tripped the refusal, the split would be decorative.
    const plan = verifierPlanOf(privateCase());
    if (!plan) throw new Error("this case has a verifier plan");
    expect(verifierPrivateMaterial(plan.remainder)).toEqual([]);
    expect(() => caseJobPayload(jobFor(plan.remainder))).not.toThrow();
    // …while the unsplit case is still refused, because a lane that forgets to split must not silently ship.
    expect(() => caseJobPayload(jobFor(privateCase()))).toThrow(/must not see/);
  });

  it("answers undefined for a case with nothing private — no second job, no second cost", () => {
    // Most cases are this. A split that manufactured a verifier job for every case would double the
    // dispatches of a fleet that has no hidden tests at all.
    const ordinary = {
      id: "c2",
      task: "do the thing",
      env: { kind: "repo", source: { path: "/app" } },
      graders: [{ id: "tests-pass", config: { cmd: "pytest" } }],
    } as unknown as EvalCase;
    expect(verifierPlanOf(ordinary)).toBeUndefined();
  });

  it("names the plan by its CONTENT, so the two jobs can be joined after the fact", () => {
    // The verifier job produces a reward, and the case's record has to be able to say which plan produced it.
    // A digest rather than a counter: two batches of one dataset run the same plan, and a replay has to be
    // able to tell that the thing that judged it then is the thing in front of it now.
    const a = verifierPlanOf(privateCase());
    const b = verifierPlanOf(privateCase());
    expect(a?.digest).toBe(b?.digest);
    expect(a?.digest).toMatch(/^[a-z0-9]+:/);

    const moved = privateCase();
    (moved.graders?.[0] as { config: Record<string, unknown> }).config.files = { "test.sh": "assert_other()" };
    expect(verifierPlanOf(moved)?.digest, "a different verifier hashed to the same plan").not.toBe(a?.digest);
  });
});
