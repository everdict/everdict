import {
  type PersistedWorkIntent,
  type RuntimeWorkRef,
  UpstreamError,
  type VerifierInvocation,
  type VerifierJob,
} from "@everdict/contracts";
import type { ManagedDispatchAuthority } from "../ports/dispatcher.js";
import type { ExecutionAttemptStore } from "../ports/execution-attempt-store.js";

// ── THE JUDGING HALF IS DURABLE WORK (arch-review 57 P0-verifier) ────────────────────────────────────
//
// arch-review 56 gave the verifier its own container and arch-review 57 gave that container a placement.
// What it still had no place in was the LEDGER: it opened no attempt, reserved no work and reported no
// handle, so nothing downstream could see it —
//
//     scheduler admission     the compute it takes is not admitted
//     attempt ledger          nothing records that a second unit was placed
//     cancellation workset    built from attempt rows, so the verifier is not in it
//     recovery / adoption     a control plane restarting mid-verify finds nothing to reconcile
//
// and the consequence is exactly what arch-review 56's cancellation certificate exists to prevent: a batch
// cancelled while a verifier runs probes the AGENT's work, finds it absent, settles the children and
// COMPLETES, while the verifier keeps running and eventually writes a verdict. "Zero live work" certified
// over a container the sweep had no way to know about — rule `protocol` L5, where a workset that cannot
// enumerate what it owes has not enumerated zero, it enumerated what it could see.
//
// So the verifier gets what every other piece of managed compute has: a row it opens BEFORE it places
// anything, a reservation naming the exact work, and a settlement either way. Nothing downstream needs
// teaching — cancellation already reads attempt rows, so the verifier becomes visible to it by being one.
export interface VerifierOperationDeps {
  // Absent on a deployment with no ledger (the CLI, single-process dev). Such a lane records nothing and
  // must still be able to judge: refusing here would make the ledger a prerequisite for a verdict rather
  // than a record of one.
  attempts?: ExecutionAttemptStore;
}

// The judging half places external work exactly as the agent's half does, so it is handed the SAME
// capability rather than a lookalike pair of hooks — see `ManagedDispatchAuthority` for what being two
// optional fields cost the agent lane (arch-review 58 W2). Required here, not optional: a verifier dispatch
// that cannot record where its container will be must not get one.
export type VerifierDispatchHooks = { authority: ManagedDispatchAuthority };

export async function verifierOperation(
  deps: VerifierOperationDeps,
  job: VerifierJob,
  dispatch: (job: VerifierJob, hooks: VerifierDispatchHooks) => Promise<VerifierInvocation>,
): Promise<VerifierInvocation> {
  const attempts = deps.attempts;
  // No ledger: nothing to record, and the lane must still be able to judge. The intent it gets back names
  // the work it reported and says plainly that no row backs it — an empty attempt id, rather than a
  // fabricated one that would read as a reservation somebody wrote.
  if (!attempts)
    return await dispatch(job, {
      authority: {
        reserve: async (work) => ({ attemptId: "", work, persistedAt: new Date(0).toISOString() }),
        activate: async () => ({ kind: "activate" }),
      },
    });

  // Its OWN row. The agent's attempt is committed by the time a verifier runs — the verdict is what closes
  // the case — so reusing it would be recording the second unit against a settled one. The `#verify` suffix
  // is what makes the two distinguishable in a ledger read, including the cancellation's.
  //
  // …under the SAME PARENT as the agent's half. A verifier row with no parent is refused by
  // `PARENT_AUTHORIZES` on every batch case and invisible to the scorecard teardown's worklist — see
  // `scorecardId` on `VerifierJobSchema` for both halves of what that cost.
  const opened = await attempts.open({
    executionId: job.runId,
    tenant: job.tenant,
    caseId: `${job.caseId}#verify`,
    ...(job.scorecardId !== undefined ? { scorecardId: job.scorecardId } : {}),
    ...(job.trial !== undefined ? { trial: job.trial } : {}),
  });
  const attemptId = opened.attemptId;

  try {
    const invocation = await dispatch(job, {
      authority: {
        reserve: async (work) => await attempts.reserveWork(attemptId, { ...work, attemptId }),
        // The verifier's own re-presentation: its row is opened under the batch's parent, so a cancellation
        // that settled while the container was being created refuses the birth here rather than after it.
        activate: async (work) => await attempts.activateWork(attemptId, { ...work, attemptId }),
      },
    });
    // ── THE TERMINAL CAS IS THIS VERDICT'S RE-PROOF (arch-review 58) ──────────────────────────────
    //
    // Settled as soon as the verdict is in hand: a row left live is compute a later sweep will chase, and
    // chasing a container that finished is how a cancellation stops converging.
    //
    // And the ANSWER is consumed, because `transition` is a conditional write and the one way it says `false`
    // here is the way that matters — something else made this attempt terminal while the verifier was judging,
    // which in practice means a cancellation revoked it. A verdict produced under an authority that was taken
    // back is not a measurement (rule `protocol` L1: the write that records the outcome is where the effect
    // re-proves its proof is still valid). The throw becomes `tests_pass: unmeasured` upstream, which says the
    // case was not judged — where a `1` would have said it passed.
    if (!(await attempts.transition(attemptId, "committed"))) {
      const state = await attempts
        .list(job.runId)
        .then((rows) => rows.find((r) => r.attemptId === attemptId)?.state ?? "absent")
        // A ledger that cannot say whether the attempt settled has not said that it did (rule `protocol` L2).
        .catch(() => "unreadable");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { attemptId, state },
        `this verifier's attempt could not be settled (it is '${state}'), so the verdict it produced was not made under a live authorization`,
      );
    }
    return invocation;
  } catch (err) {
    // …and settled on failure too, for the same reason: an abandoned row is owed forever. The error keeps
    // travelling — `withVerifierPass` turns it into `unmeasured`, which is the honest verdict.
    await attempts
      .transition(attemptId, "failed", {
        error: { code: "UPSTREAM_ERROR", message: err instanceof Error ? err.message : String(err) },
      })
      .catch(() => undefined);
    throw err;
  }
}
