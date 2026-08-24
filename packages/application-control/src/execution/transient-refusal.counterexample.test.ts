import type { CaseJob, CaseResult, VerifierInvocation } from "@everdict/contracts";
import { BadRequestError, RateLimitError, UpstreamError } from "@everdict/contracts";
import { classifyFailure } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { withVerifierPass } from "./verifier-pass.js";

// ── A LANE THAT IS MOMENTARILY FULL IS NOT A CASE THAT CANNOT BE JUDGED (arch-review 64 P2) ──────────
//
// A verifier lane with no slots — or one whose capacity could not be counted, which is fail-closed since
// arch-review 63 — refuses with `RATE_LIMITED`. `withVerifierPass` caught it and returned
// `tests_pass: unmeasured`.
//
// `runSuite` retries a dispatch that THREW. A successfully returned unmeasured result is final. So a capacity
// blip lasting seconds settled a case permanently unjudged — while the comments around the refusal said the
// caller would retry, which is the comment-is-a-claim law: the retry lives in a component three frames away
// and it was never reached.
//
// Rethrown, so the transient retry the batch already has consumes it. That re-runs the agent half as well,
// which is the honest price of not owning a second queue: a re-run costs compute, an unjudged case costs the
// measurement, and only one of those is recoverable.
//
// Seen RED before the rethrow, observed:
//   a momentary capacity refusal was settled as a permanently unjudged case: expected 'unmeasured' to be undefined

const JOB = (): CaseJob =>
  ({
    tenant: "acme",
    runId: "evd-run-r1",
    harness: { id: "h", version: "1" },
    evalCase: {
      id: "c1",
      task: "t",
      env: { kind: "repo", source: { path: "/app" } },
      // A grader is PRIVATE when its config carries material the agent must not see — `files`/`env`, per
      // `PRIVATE_GRADER_CONFIG_KEYS`. A hand-invented `private: true` makes no plan at all, and the pass then
      // returns the plain dispatch: the first draft of this file measured nothing (rule `testing`, a fixture
      // must reach the predicate).
      graders: [{ id: "reward-file", config: { files: { "tests/test.sh": "exit 0" } } }],
      timeoutSec: 60,
      tags: [],
    },
  }) as unknown as CaseJob;

const AGENT_RESULT: CaseResult = {
  caseId: "c1",
  harness: "h@1",
  trace: [],
  scores: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], base: "b", headSha: "h" },
} as unknown as CaseResult;

const passWith = async (refusal: Error) =>
  await withVerifierPass(JOB(), {
    dispatch: async () => AGENT_RESULT,
    dispatchVerifier: async (): Promise<VerifierInvocation> => {
      throw refusal;
    },
  } as never)
    .then((result) => ({ kind: "settled" as const, result }))
    .catch((err: unknown) => ({ kind: "threw" as const, err }));

const verdictOf = (result: CaseResult) => result.scores?.find((s) => s.metric === "tests_pass")?.status;

describe("[R64 COUNTEREXAMPLE] a transient verifier refusal is retried, not recorded", () => {
  it("RETHROWS a capacity refusal so the batch's retry can consume it", async () => {
    const outcome = await passWith(
      new RateLimitError("RATE_LIMITED", { runtime: "nomad-dev" }, "this runtime has no room for the verifier"),
    );

    expect(outcome.kind, "a momentary capacity refusal was settled as a permanently unjudged case").toBe("threw");
    if (outcome.kind !== "threw") return;
    // …and it reaches the retry as a retryable failure, which is the whole point of throwing it.
    expect(classifyFailure(outcome.err, "run").retryable).toBe(true);
  });

  it("still RECORDS a verifier that genuinely failed", async () => {
    // The control. A verifier container that errored is an answer about THIS case, and repeating it changes
    // nothing — recording `unmeasured` is the honest statement, and turning it into a retry would spend the
    // agent's compute again for the same answer.
    const outcome = await passWith(new UpstreamError("UPSTREAM_ERROR", {}, "the verifier container crashed"));
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(verdictOf(outcome.result)).toBe("unmeasured");
  });

  it("still RECORDS a refusal that is about the case itself", async () => {
    // The other control: a 4xx that will answer the same way forever must not become an infinite retry.
    const outcome = await passWith(new BadRequestError("BAD_REQUEST", {}, "this case declares no verifier plan"));
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(verdictOf(outcome.result)).toBe("unmeasured");
  });
});
