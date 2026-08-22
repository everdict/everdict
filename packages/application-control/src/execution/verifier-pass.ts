import type { CaseJob, CaseResult, Score, VerifierInvocation, VerifierJob } from "@everdict/contracts";
import { type VerifierReceipt, verifierPlanOf, verifierReceiptOf } from "@everdict/domain";
import { type AgentHalfStore, mergeVerifierPass, stageAgentHalf } from "./agent-half.js";

// ── A CASE WHOSE VERDICT IS PRIVATE STILL RUNS (arch-review 56, Wave K) ──────────────────────────────
//
// Wave B made the dispatch REFUSE a case whose grading depends on material the agent must not see. That was
// the right first move and it is not the end: `terminal-bench.ts` puts a task's hidden `tests/` bytes and its
// verifier env in the grader config — it always did — so the refusal stopped every Terminal-Bench task with
// tests from dispatching on a managed lane. Fail-closed beats leaking the answer key, and a benchmark that
// cannot run beats neither.
//
// This is the seam that uses the two halves the last waves built:
//
//     dispatch(remainder)                      → CaseResult{ snapshot, scores: [observation…] }
//       → dispatchVerifier({ plan, snapshot })   → [ tests_pass, reward:… ]
//         → CaseResult{ scores: [observation…, verdict…] }
//
// The agent's container never holds the plan, so the disclosure is closed by CONSTRUCTION rather than by the
// ordering of writes inside one container — which is what "the tests are copied after the agent finishes"
// could never provide.
export interface VerifierPassDeps {
  // Run the agent's half. Whatever the caller already uses — a backend, the scheduler, the in-process driver.
  dispatch: (job: CaseJob) => Promise<CaseResult>;
  // Run the judging half somewhere the agent was not. Absent = this deployment has no second lane, which is a
  // reason to REFUSE the case (the dispatch below already does), never to grade it in the agent's container.
  // Answers the INVOCATION, not bare numbers (arch-review 57 P1) — which procedure ran, what it read, and
  // where. `verifierReceiptOf` seals that into the receipt this pass attaches to the result.
  dispatchVerifier?: (job: VerifierJob) => Promise<VerifierInvocation>;
  // Where the agent's half is STAGED before the second container exists — see `stageAgentHalf`. Absent means
  // this deployment cannot recover a case that crashed between the halves, which is what it could do before;
  // it never changes what a case that completes normally produces.
  agentHalves?: AgentHalfStore;
}

// The verdict a case owes but did not get. `unmeasured` rather than a zero, for the reason the reward-file
// grader states: a number the benchmark never produced must not reach a mean, a leaderboard or a diff. The
// metric is fixed here rather than taken from the plan, because a case that could not be judged has no plan
// output to take it from.
function unmeasuredVerdict(reason: "unsupported" | "missing_evidence" | "grader_error", detail: string): Score {
  return {
    graderId: "verifier",
    metric: "tests_pass",
    status: "unmeasured",
    reason,
    retryable: true,
    detail,
  } as Score;
}

export async function withVerifierPass(job: CaseJob, deps: VerifierPassDeps): Promise<CaseResult> {
  const plan = verifierPlanOf(job.evalCase);
  // Nothing private: the case grades itself in place, and paying for a second unit would charge every
  // ordinary case for a lane it does not use.
  if (!plan) return await deps.dispatch(job);

  const result = await deps.dispatch({ ...job, evalCase: plan.remainder });
  // ── THE FIRST PHASE, MADE DURABLE BEFORE THE SECOND EXISTS (arch-review 60 follow-through) ────────
  //
  // The backend deletes the agent's Job as soon as it has parsed this result, so from here until the merge
  // below the agent's evidence lives in exactly one place: this variable. A control plane that dies here
  // leaves a recovery with a live verifier Job and nothing to attach its verdict to — which is why arch-review
  // 60 had to make the recovery SKIP a recovered verdict rather than merge it.
  //
  // Staged now, keyed by the execution, so that recovery can read it back and finish the same merge. See
  // `stageAgentHalf` for why its failure is swallowed and what that costs.
  if (job.runId !== undefined && job.tenant !== undefined)
    await stageAgentHalf(deps.agentHalves, job.tenant, job.runId, result);

  // A verdict this deployment cannot reach is stated, never omitted. An omitted one leaves a CaseResult whose
  // scores are the observation-only ones, which reads downstream as "graded, and it scored nothing".
  const owed = (reason: "unsupported" | "missing_evidence" | "grader_error", detail: string): CaseResult => ({
    ...result,
    scores: [...(result.scores ?? []), unmeasuredVerdict(reason, detail)],
  });

  if (!deps.dispatchVerifier)
    return owed("unsupported", "this deployment has no lane that can judge a case away from its agent");
  // Only a repo snapshot can be reconstituted. A prompt or browser case has no file tree, so a verifier job
  // for it would provision a container, restore nothing, and score the bare image.
  if (result.snapshot?.kind !== "repo")
    return owed(
      "missing_evidence",
      `this case's environment left a '${result.snapshot?.kind ?? "absent"}' snapshot, which has no workspace to judge`,
    );

  // ── A VERIFIER WITHOUT A TENANT HAS NO LANE, AND MUST NOT GUESS ONE (arch-review 57) ──────────────
  //
  // `CaseJob.runId` and `.tenant` are optional; `VerifierJob` requires both, and the first version bridged
  // that with `as VerifierJob`. Undefined would have gone straight into the runtime resolution that picks the
  // lane — a verifier is dispatched with the tenant's credentials against the tenant's image, so resolving it
  // under no tenant is not a smaller question but a different one. The honest answer is that this deployment
  // cannot judge THIS case, which is what `owed` records.
  if (job.runId === undefined || job.tenant === undefined)
    return owed(
      "missing_evidence",
      "this case was dispatched with no run id or no tenant, so there is no lane a verifier could be resolved against",
    );

  const verifierJob: VerifierJob = {
    runId: job.runId,
    tenant: job.tenant,
    caseId: job.evalCase.id,
    ...(job.evalCase.image !== undefined ? { image: job.evalCase.image } : {}),
    // The in-image working directory, when the case declared one. A cloned repo lands at the driver's own
    // root, which is what the verifier's default covers.
    workdir:
      job.evalCase.env.kind === "repo" && "path" in job.evalCase.env.source ? job.evalCase.env.source.path : "/app",
    workspace: result.snapshot,
    plan: { digest: plan.digest, graders: plan.graders },
    // The lane that ran the agent is the lane that judges it — see `placementTarget` on the schema for what
    // passing nothing here used to cost.
    ...(job.evalCase.placement?.target !== undefined ? { placementTarget: job.evalCase.placement.target } : {}),
    // The same budget the agent had — see `timeoutSec` on the schema for what passing none used to cost.
    timeoutSec: job.evalCase.timeoutSec,
    // The DECLARED WORLD and the credentials for the task image. Both fields have been on the schema since
    // the lane was built and neither had a producer (arch-review 58 P1), so the judging half ran under the
    // lane's defaults against a registry it could not authenticate to — a schema field with no producer is a
    // promise the wire does not keep.
    ...(job.evalCase.resources !== undefined ? { resources: job.evalCase.resources } : {}),
    // …and the declared NETWORK, for the same reason and with a sharper edge — see `network` on the schema.
    ...(job.evalCase.network !== undefined ? { network: job.evalCase.network } : {}),
    ...(job.registryAuths !== undefined ? { registryAuths: job.registryAuths } : {}),
    // WHOSE second unit this is — see `scorecardId` on the schema for what a parentless row costs. `batchId`
    // already IS the scorecard's id in the batch path, so the coordinate travels as itself rather than being
    // parsed back out of the execution id (rule `protocol` L3).
    ...(job.batchId !== undefined ? { scorecardId: job.batchId } : {}),
    ...(job.trial !== undefined ? { trial: job.trial } : {}),
    ...(job.driverEpoch !== undefined ? { driverEpoch: job.driverEpoch } : {}),
  };

  const invocation = await deps.dispatchVerifier(verifierJob).catch((err: unknown) => err);
  if (invocation instanceof Error || !(invocation as VerifierInvocation)?.scores)
    return owed("grader_error", invocation instanceof Error ? invocation.message : String(invocation));

  // ── THE VERDICT AND WHAT PRODUCED IT, TOGETHER (arch-review 57 P1) ──────────────────────────────
  //
  // The scores used to be appended alone, so the record could report `tests_pass` and not say which
  // procedure read which workspace in which runtime to get it. `verifierReceiptOf` seals the invocation —
  // digesting the verdict plane and stating whether the runtime identity is there — and the receipt rides
  // the result beside the scores it explains.
  //
  // A receipt that cannot be sealed (an empty verdict) is `unmeasured`, not a silently dropped receipt: a
  // case that was never judged must not read as one that was.
  //
  // …and the merge itself is ONE function, shared with the recovery (rule `protocol` L5). Two spellings of
  // "combine these halves" would make a case recovered after a crash a different document from one that
  // finished normally, and both are `CaseResult`s, so the difference would be invisible.
  try {
    return mergeVerifierPass(result, invocation as VerifierInvocation);
  } catch (err) {
    return owed("grader_error", err instanceof Error ? err.message : String(err));
  }
}
