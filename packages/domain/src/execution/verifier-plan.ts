import { type EvalCase, type GraderSpec, PRIVATE_GRADER_CONFIG_KEYS } from "@everdict/contracts";
import { contentDigest } from "../provenance/content-digest.js";

// ── A CASE SPLITS INTO WHAT THE AGENT DOES AND HOW IT IS JUDGED (arch-review 56, Wave H) ─────────────
//
// Wave B closed the task-format disclosure by REFUSING. `caseJobPayload` throws for a case whose grading depends on
// material the agent must not see, because the job payload is base64'd into the container the harness runs in
// and `LocalDriver` spawns the harness with the process environment inherited — so "the tests are copied after
// the agent finishes" was true of the filesystem and said nothing about disclosure.
//
// A refusal is the right answer to a lane that cannot measure the case honestly. It is not an answer to the
// benchmark. This is: the case separates, and the two halves travel to different containers, so nothing about
// the ORDER of operations is load-bearing any more.
//
//     case job                        verifier job
//     ─────────────                   ─────────────
//     instruction, env, image         the frozen workspace, read-only
//     observation-only graders        + the hidden tests
//     (no tests, no verifier env)     + a fresh reward volume
//                                     → reward bytes
//
// WHY IT LIVES IN DOMAIN and not beside `verifierPrivateMaterial` in contracts: the split is content-addressed,
// and `contentDigest` is domain's. Spelling a second digest in contracts to keep the pair together would be
// the "a predicate written twice has already diverged" defect this review already paid for twice. The
// classification (`PRIVATE_GRADER_CONFIG_KEYS`) stays in contracts, where the dispatchers can reach it.
export interface VerifierPlan {
  // The graders that DECIDE, with their configuration intact. This object is never part of what a backend
  // serializes for the agent — that is the whole point.
  graders: GraderSpec[];
  // The case the agent is given: everything it needs to do the work and nothing that judges it.
  remainder: EvalCase;
  // WHICH verifier this is, by content. A counter would not survive two batches of one dataset running the
  // same plan, and a replay has to be able to say that the thing which judged it then is the thing in front of
  // it now. Covers the deciding graders only — the agent's half can change (a re-worded instruction) without
  // making it a different verdict procedure.
  digest: string;
}

// The split, or `undefined` when there is nothing to split. Most cases are the second: a fleet whose cases
// carry no hidden material must not pay for a second dispatch to run a verifier that could have run in place.
export function verifierPlanOf(evalCase: EvalCase): VerifierPlan | undefined {
  const graders = evalCase.graders ?? [];
  const decides = (grader: GraderSpec): boolean => {
    const config = grader.config;
    if (config === undefined || config === null || typeof config !== "object") return false;
    return PRIVATE_GRADER_CONFIG_KEYS.some((key) => Object.hasOwn(config as Record<string, unknown>, key));
  };
  const priv = graders.filter(decides);
  if (priv.length === 0) return undefined;
  return {
    graders: priv,
    // The remainder keeps its observation-only graders: they read the trace and the snapshot, decide nothing
    // the agent must not see, and moving them would make every case pay the second dispatch.
    remainder: { ...evalCase, graders: graders.filter((g) => !decides(g)) },
    digest: contentDigest(priv),
  };
}
