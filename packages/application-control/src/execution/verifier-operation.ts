import type { PersistedWorkIntent, RuntimeWorkRef, VerifierInvocation, VerifierJob } from "@everdict/contracts";
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

export interface VerifierDispatchHooks {
  // Called by the lane with the exact work it is about to create, BEFORE it creates it — the same ordering
  // the agent's dispatch uses, and for the same reason: a handle reported after the apply leaves a control
  // plane that died in between with a running job nothing can address.
  onReserved: (work: RuntimeWorkRef) => Promise<PersistedWorkIntent>;
}

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
      onReserved: async (work) => ({ attemptId: "", work, persistedAt: new Date(0).toISOString() }),
    });

  // Its OWN row. The agent's attempt is committed by the time a verifier runs — the verdict is what closes
  // the case — so reusing it would be recording the second unit against a settled one. The `#verify` suffix
  // is what makes the two distinguishable in a ledger read, including the cancellation's.
  const opened = await attempts.open({
    executionId: job.runId,
    tenant: job.tenant,
    caseId: `${job.caseId}#verify`,
  });
  const attemptId = opened.attemptId;

  try {
    const invocation = await dispatch(job, {
      onReserved: async (work) => await attempts.reserveWork(attemptId, { ...work, attemptId }),
    });
    // Settled as soon as the verdict is in hand. A row left live is compute a later sweep will chase, and
    // chasing a container that finished is how a cancellation stops converging.
    await attempts.transition(attemptId, "committed");
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
