import { AppError, UpstreamError } from "@everdict/contracts";
import type { CaseJob, CaseResult, Score, VerifierInvocation, VerifierJob } from "@everdict/contracts";
import { verifierPlanOf } from "@everdict/domain";
import type { DispatchOptions } from "../ports/dispatcher.js";
import type { ExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import type { IntermediateCleanupStore } from "../ports/intermediate-cleanup-store.js";
import {
  type AgentHalfStageOutcome,
  type AgentHalfStore,
  agentHalfDigest,
  mergeVerifierPass,
  stageAgentHalf,
} from "./agent-half.js";
import { jobAttemptId } from "./open-physical-attempt.js";
import type { VerifierDurabilityPolicy } from "./verifier-operation.js";

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
  // …and the OPTIONS it forwards, so this pass can hand the backend an acknowledgement to call before it
  // reclaims the agent's container (arch-review 67 P0-lifecycle).
  dispatch: (job: CaseJob, options?: DispatchOptions) => Promise<CaseResult>;
  // Run the judging half somewhere the agent was not. Absent = this deployment has no second lane, which is a
  // reason to REFUSE the case (the dispatch below already does), never to grade it in the agent's container.
  // Answers the INVOCATION, not bare numbers (arch-review 57 P1) — which procedure ran, what it read, and
  // where. `verifierReceiptOf` seals that into the receipt this pass attaches to the result.
  dispatchVerifier?: (job: VerifierJob) => Promise<VerifierInvocation>;
  // Where the agent's half is STAGED before the second container exists — see `stageAgentHalf`. Absent means
  // this deployment cannot recover a case that crashed between the halves, which is what it could do before;
  // it never changes what a case that completes normally produces.
  agentHalves?: AgentHalfStore;
  // Where the cleanup debt for those staged bytes is recorded (arch-review 66). Absent = this deployment
  // keeps the previous behaviour, in which the objects are owed to nobody.
  cleanup?: IntermediateCleanupStore;
  // ── SO A VERDICT THAT DID NOT CONTRIBUTE CAN SAY SO (arch-review 63 P1-high) ─────────────────────
  //
  // `verifierOperation` stamps the verifier's attempt `committed` the moment the verdict exists, and the
  // merge that decides whether the verdict is USED happens here, afterwards. When that merge is refused —
  // the verdict was produced against a different workspace than the half it would join — the ledger is left
  // saying an attempt contributed to a case that did not take it.
  //
  // The deeper repair is a pre-terminal state (`verdict_produced`) so `committed` is only ever written by
  // the settlement, and that is a vocabulary change every guard has to be re-walked for. This closes the one
  // case where the record is demonstrably false, in the vocabulary that exists: the attempt is SUPERSEDED,
  // which is what an attempt whose work another one replaced already means.
  attempts?: Pick<ExecutionAttemptStore, "transition">;
  // ── WHAT AN UNWRITABLE AGENT HALF COSTS, DECLARED RATHER THAN ASSUMED (arch-review 70 P0) ────────
  //
  // The same policy `verifierOperation` takes for the verdict, spelled once for BOTH halves of a two-phase
  // case: a deployment cannot sensibly require the verdict be durable and let the evidence it judges be
  // best-effort. Absent = `best_effort`, which is what every caller had before this existed.
  durability?: VerifierDurabilityPolicy;
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

  // ── THE AGENT'S HALF IS DURABLE BEFORE ITS CONTAINER IS RECLAIMED (arch-review 67 P0-lifecycle) ──
  //
  // The verifier lane got this seam in arch-review 66 and this one did not. Every managed backend parses its
  // logs, builds the result, and reclaims the object in a `finally` — so staging AFTER the dispatch resolved
  // meant a crash there lost a completed agent execution with its container already gone.
  //
  // ⚠️ AND IT MUST NOT STAGE FOR A VERIFIER THAT WILL NEVER RUN (arch-review 62): a half written for a
  // refused case is garbage the moment it is written. Every refusal below is decidable HERE — the lane's
  // presence and the tenant/run coordinate are known before the dispatch, and the snapshot kind is on the
  // result being handed over — so the decision is made once and spent twice.
  // ── WHAT THE HANDOVER PROVED, NOT THAT IT RAN (arch-review 70 P0) ────────────────────────────────
  //
  // This was a boolean set immediately after an awaited `Promise<void>`, so it recorded that the stage had
  // been CALLED. A refused put therefore produced a successful acknowledgement, a reclaimed container, and a
  // skipped fallback — three consequences of one unread answer.
  //
  // `required` is the deployment that treats the private verdict as constitutional evidence: an unwritable
  // half fails the acknowledgement, so the lane never reaches its cleanup and the container stays
  // inspectable. `best_effort` (the default, and what every caller had before this) keeps the measurement
  // and accepts that a crash here costs the recovery — the same trade `verifierOperation` already declares
  // for the verdict, now spelled once for both halves.
  const requiresDurableHalf = deps.durability === "required";
  const stageHalf = async (r: CaseResult, tenant: string, runId: string): Promise<AgentHalfStageOutcome> =>
    await stageAgentHalf(deps.agentHalves, tenant, runId, r, deps.cleanup).catch((err: unknown) => {
      if (requiresDurableHalf) throw err;
      return { kind: "absent" as const, reason: err instanceof Error ? err.message : String(err) };
    });
  let stagedEarly = false;
  const willJudge = (r: CaseResult): boolean =>
    deps.dispatchVerifier !== undefined &&
    r.snapshot?.kind === "repo" &&
    job.runId !== undefined &&
    job.tenant !== undefined;
  const result = await deps.dispatch(
    { ...job, evalCase: plan.remainder },
    {
      acknowledgeResult: async (r) => {
        if (!willJudge(r) || job.tenant === undefined || job.runId === undefined) return r;
        const staged = await stageHalf(r, job.tenant, job.runId);
        if (requiresDurableHalf && staged.kind !== "staged")
          throw new UpstreamError(
            "UPSTREAM_ERROR",
            { runId: job.runId, reason: staged.reason },
            `this case's agent half could not be made durable (${staged.reason}), and this deployment requires durability before its container is reclaimed`,
          );
        // The bytes, not the call. A stage that answered `absent` leaves the fallback below its second
        // chance rather than silently spending it.
        stagedEarly = staged.kind === "staged";
        return r;
      },
    },
  );
  // ── THE FIRST PHASE, MADE DURABLE BEFORE THE SECOND EXISTS (arch-review 60 follow-through) ────────
  //
  // The backend deletes the agent's Job as soon as it has parsed this result, so from here until the merge
  // below the agent's evidence lives in exactly one place: this variable. A control plane that dies here
  // leaves a recovery with a live verifier Job and nothing to attach its verdict to — which is why arch-review
  // 60 had to make the recovery SKIP a recovered verdict rather than merge it.
  //
  // Staged now, keyed by the execution, so that recovery can read it back and finish the same merge. See
  // `stageAgentHalf` for why its failure is swallowed and what that costs.
  // …and WHICH half it is, computed over the document the stage below writes, so the verifier job can carry
  // the coordinate rather than have a recovery guess it from something two attempts share (arch-review 62).
  const stagedDigest = agentHalfDigest(result);

  // A verdict this deployment cannot reach is stated, never omitted. An omitted one leaves a CaseResult whose
  // scores are the observation-only ones, which reads downstream as "graded, and it scored nothing".
  // ── EVERY ENDING ALREADY OWES WHAT THIS PASS STAGED (arch-review 65 P1-high → 66) ────────────────
  //
  // arch-review 65 stamped the cleanup coordinate onto every outcome here, because `owed` — the verifier
  // could not be reached, errored, or produced a verdict the merge refused — carries no verifier receipt to
  // dig it out of. Right problem, wrong document: `CaseResult` is the measurement, and platform lifecycle
  // state on it made the recovered document differ from the normal one and handed a runner the ability to
  // name objects for deletion.
  //
  // The debt is recorded by `stageAgentHalf`/`stageVerifierVerdict` themselves now, keyed by execution, so
  // EVERY ending owes it without carrying anything — including the `RATE_LIMITED` rethrow below, which
  // returns no document at all and could never have carried a stamp.
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
    // WHICH physical agent half this verdict will be merged into — see `agentResultDigest` on the schema.
    agentResultDigest: stagedDigest,
    // …and which physical execution produced it. Read through the SAME helper every other consumer uses, so
    // the id the receipt names is the id the ledger holds rather than a second derivation of it.
    ...(jobAttemptId(job, job.runId) !== undefined ? { agentAttemptId: jobAttemptId(job, job.runId) } : {}),
    ...(job.batchId !== undefined ? { scorecardId: job.batchId } : {}),
    ...(job.trial !== undefined ? { trial: job.trial } : {}),
    ...(job.driverEpoch !== undefined ? { driverEpoch: job.driverEpoch } : {}),
  };

  // ── THE WINDOW OPENS HERE (arch-review 62 follow-through) ────────────────────────────────────────
  //
  // Staged immediately before the second container is dispatched, which is where the window actually starts:
  // the earlier placement wrote a half for every case with a verifier PLAN, including the ones refused two
  // lines later for having no repo snapshot or no lane to judge on — halves for a verifier that was never
  // dispatched, and therefore garbage the moment they were written.
  // …unless the lane already did it, before reclaiming. A lane with no acknowledgement keeps the ordering it
  // had, which is this line.
  if (!stagedEarly) await stageHalf(result, job.tenant, job.runId);

  const invocation = await deps.dispatchVerifier(verifierJob).catch((err: unknown) => err);
  if (invocation instanceof Error || !(invocation as VerifierInvocation)?.scores) {
    // ── A LANE THAT IS MOMENTARILY FULL IS NOT A CASE THAT CANNOT BE JUDGED (arch-review 64 P2) ─────
    //
    // A verifier lane with no slots — or one whose capacity could not be counted — refuses with
    // `RATE_LIMITED`, and this turned it into `tests_pass: unmeasured`. `runSuite` retries a dispatch that
    // THREW; a successfully returned unmeasured result is final. So a capacity blip lasting seconds settled
    // a case permanently unjudged, while the comments around the refusal said the caller would retry.
    //
    // Rethrown so the transient retry the batch already has can consume it. That re-runs the agent half too,
    // which is the honest price of not owning a second queue: a case re-run costs compute, and a case
    // recorded as unjudged costs the measurement. Only `RATE_LIMITED` — a budget refusal, a missing lane and
    // a verifier that genuinely errored are all answers about THIS case, and repeating them changes nothing.
    if (invocation instanceof AppError && invocation.code === "RATE_LIMITED") throw invocation;
    // The half stays. A verifier that failed leaves a case that still has to be COMPLETED and settled, and
    // a crash before that settlement is exactly what the half exists to survive (arch-review 63 P0). What
    // ends its window is the canonical settlement, never the step that read it.
    return owed("grader_error", invocation instanceof Error ? invocation.message : String(invocation));
  }

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
    // The verdict exists and was NOT used, so the row that claims it contributed is corrected here rather
    // than left to read as the case's answer. Best-effort: a ledger that will not take the correction must
    // not turn a refused merge into a failed case, which is already `unmeasured` below.
    const verifierAttempt = (invocation as VerifierInvocation).work?.attemptId;
    if (verifierAttempt !== undefined)
      await deps.attempts?.transition(verifierAttempt, "superseded").catch(() => undefined);
    return owed("grader_error", err instanceof Error ? err.message : String(err));
  }
}
