import {
  type RuntimeWorkRef,
  UpstreamError,
  type VerifierInvocation,
  type VerifierJob,
  storedExecutionId,
} from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import type { ManagedDispatchAuthority } from "../ports/dispatcher.js";
import type { ExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import { type AgentHalfStore, stageVerifierVerdict } from "./agent-half.js";

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
  // ── WHERE THE VERDICT ITSELF BECOMES DURABLE (arch-review 64 P0) ─────────────────────────────────
  //
  // The agent's half has been staged since arch-review 60; the VERDICT never was. A lane reclaims its
  // verifier container the moment it has parsed the logs, so from then until the canonical settlement the
  // invocation lived only in this process. A crash there re-ran a case whose judgement was already computed.
  //
  // Absent = this deployment cannot recover a two-phase case that crashed after its verdict, which is what it
  // could do before. It never changes what a case that completes normally produces.
  verdicts?: AgentHalfStore;
}

// The judging half places external work exactly as the agent's half does, so it is handed the SAME
// capability rather than a lookalike pair of hooks — see `ManagedDispatchAuthority` for what being two
// optional fields cost the agent lane (arch-review 58 W2). Required here, not optional: a verifier dispatch
// that cannot record where its container will be must not get one.
export type VerifierDispatchHooks = {
  authority: ManagedDispatchAuthority;
  // ── HAND THE VERDICT OVER BEFORE RECLAIMING WHAT PRODUCED IT (arch-review 66 P0-lifecycle) ────────
  //
  // Every managed lane reads its container's logs, builds the invocation, and reclaims the object in a
  // `finally` — and only THEN does the returned value reach this operation, which canonicalizes and stages
  // it. So the ordinary shape of a crash here was:
  //
  //     verifier logs parsed → verifier Job deleted → ✗ → the verdict is gone
  //
  // A constitutional decision that had already been computed and paid for was tied to the lifetime of the
  // process holding it, with the container that could have re-produced it already destroyed.
  //
  // The lane calls this INSIDE its try, before its cleanup runs. What it hands over is the raw answer; what
  // comes back is the canonical document — the same one this operation returns — so the lane can keep it
  // and the two can never be different documents again (arch-review 65 P0, one layer up).
  //
  // A lane that does not call it is the old behaviour and still works: the operation canonicalizes and
  // stages after the fact, and says so on the invocation it returns. Not optional because a deployment
  // legitimately lacks it — optional because two lanes had to learn it, and the one that has not yet must
  // not silently claim the property.
  acknowledge?: (invocation: VerifierInvocation) => Promise<VerifierInvocation>;
};

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
    // `VerifierJob.runId` IS the execution id — the caller built it (`evd-<sc>-<case>[-t<n>]` for a batch,
    // `evd-run-<id>` for a standalone), and this row opens under the same one the agent's half did.
    executionId: storedExecutionId(job.runId),
    tenant: job.tenant,
    caseId: `${job.caseId}#verify`,
    ...(job.scorecardId !== undefined ? { scorecardId: job.scorecardId } : {}),
    ...(job.trial !== undefined ? { trial: job.trial } : {}),
    ...(job.driverEpoch !== undefined ? { driverEpoch: job.driverEpoch } : {}),
  });
  const attemptId = opened.attemptId;
  // The identity a verdict for this unit must carry, exactly as `parseVerifierResult` demands it — so a
  // container adopted after a restart is checked by the same rule as one read in-line.
  const verifierCoordinate = {
    planDigest: job.plan.digest,
    workspaceDigest: contentDigest(job.workspace),
    caseId: job.caseId,
    // …and WHICH physical agent half this verdict belongs to, so a recovery that adopts this container's
    // answer addresses the exact staged bytes rather than whatever is at a key two attempts share
    // (arch-review 62 P1). Absent for a deployment that stages nothing, which is the case a recovery already
    // handles by skipping.
    ...(job.agentResultDigest !== undefined ? { agentResultDigest: job.agentResultDigest } : {}),
    ...(job.agentAttemptId !== undefined ? { agentAttemptId: job.agentAttemptId } : {}),
  };

  // ── WHERE THIS VERDICT WAS PRODUCED, KEPT (arch-review 60 P1-provenance) ────────────────────────────
  //
  // `VerifierReceipt.complete` requires `invocation.work`, and the Nomad lane cannot answer it: its job id is
  // minted inside `dispatch` and the verifier's own return value is built from what the poll saw, so a
  // digest-pinned Nomad verifier that ran perfectly produced a receipt that read INCOMPLETE — partial
  // judgment evidence, an unverified `execution_world`, and a replay that cannot say which Nomad job made
  // the verdict.
  //
  // The handle is not missing: it is exactly what the reservation below persisted. Kept here and merged into
  // whatever the lane answered, so the receipt's coordinate comes from the write that made it durable rather
  // than from a lane that may not know its own id yet (rule `protocol` L3 — born at the source).
  let persistedWork: RuntimeWorkRef | undefined;
  // What the lane handed over before it reclaimed, if it did.
  let acknowledged: VerifierInvocation | undefined;

  // The canonical document: the lane's answer joined to the coordinates only the ledger has. Written once
  // and spent by both the acknowledgement and the fallback, because two spellings of "the canonical
  // invocation" is exactly the divergence arch-review 65 closed.
  const canonicalize = (invocation: VerifierInvocation): VerifierInvocation => ({
    ...invocation,
    work: persistedWork,
    // The judged execution, from the job that named it — so the receipt this becomes carries both halves'
    // attempts rather than only the one that produced the verdict.
    ...(job.agentAttemptId !== undefined ? { agentAttemptId: job.agentAttemptId } : {}),
  });

  try {
    const invocation = await dispatch(job, {
      // Called by the lane before its cleanup. Everything the fallback does, done EARLIER — canonicalize,
      // then make durable — so a crash after the container is gone still has the verdict.
      acknowledge: async (raw) => {
        if (persistedWork === undefined)
          throw new UpstreamError(
            "UPSTREAM_ERROR",
            { attemptId },
            "this verifier acknowledged a verdict before reserving a handle, so nothing can say which container made it",
          );
        // Named for the moment it belongs to. It used to be `canonical`, which made this line byte-identical
        // to the fallback stage below — and a mutation rung aimed at "the raw wire is staged" then matched
        // THIS copy, which the suite pinning that protocol never executes. A rung whose `from` is not unique
        // is aimed at whichever copy comes first (arch-review 66).
        const handedOver = canonicalize(raw);
        await stageVerifierVerdict(deps.verdicts, {
          tenant: job.tenant,
          runId: job.runId,
          agentResultDigest: job.agentResultDigest,
          verifierAttemptId: attemptId,
          invocation: handedOver,
        }).catch(() => undefined);
        acknowledged = handedOver;
        return handedOver;
      },
      authority: {
        // …and WHICH PROTOCOL reads this work's answer, stamped where the handle becomes durable. A verifier
        // prints a different document than a case, and adoption had no way to know which one a handle names —
        // see `verifier` on `RuntimeWorkRefSchema` for what a run's recovery did with the wrong parser. Born
        // here, from the job in hand, rather than re-derived from an id suffix at the recovery site.
        reserve: async (work) => {
          const intent = await attempts.reserveWork(attemptId, { ...work, attemptId, verifier: verifierCoordinate });
          // The CANONICAL handle — the store's answer, not the offer, because an idempotent re-reservation
          // hands back the one already on the row and that is the object this verdict belongs to.
          persistedWork = intent.work;
          return intent;
        },
        // The verifier's own re-presentation: its row is opened under the batch's parent, so a cancellation
        // that settled while the container was being created refuses the birth here rather than after it.
        activate: async (work) => await attempts.activateWork(attemptId, { ...work, attemptId }),
      },
    });
    // ── THE CANONICAL HANDLE IS THE ROW'S, NOT THE LANE'S (arch-review 62 P1-provenance) ───────────
    //
    // The previous version preferred `invocation.work` and fell back to the reservation, with a comment
    // saying `attemptId` rides along so a receipt can join the verdict to the physical row. It does not: the
    // K8s lane answers `{tenant, runId, externalJobId, namespace}` and nothing else, so on that whole lane a
    // digest-pinned verifier produced a receipt reading `complete` — `work` is present, provenance is
    // resolved — that no query can join to the attempt that made it. A promise about another component,
    // three frames away, and the component did not keep it.
    //
    // The row's handle is not a weaker version of the lane's: `reserveWork` stored the lane's own named
    // object PLUS the coordinates only the ledger has, so it is the same object described completely. It
    // wins for that reason rather than by preference.
    if (persistedWork === undefined)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { attemptId },
        "this verifier produced a verdict without a reserved handle, so nothing can say which container made it",
      );
    // …and a lane naming a DIFFERENT object than the one it reserved is not a richer answer, it is two
    // objects. Refused rather than reconciled: the alternative is a receipt whose external id and whose
    // attempt row describe different containers, which is exactly the join this is here to make trustworthy.
    if (invocation.work !== undefined && invocation.work.externalJobId !== persistedWork.externalJobId)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { attemptId, reserved: persistedWork.externalJobId, reported: invocation.work.externalJobId },
        "this verifier reported a different container than the one it reserved, so its verdict cannot be attributed",
      );
    // Already canonicalized and staged by the lane's own acknowledgement, before it reclaimed the container.
    // Re-derived here only when the lane did not ask (see `acknowledge`).
    const canonical: VerifierInvocation = acknowledged ?? canonicalize(invocation);

    // ── THE DOCUMENT THAT BECOMES DURABLE IS THE DOCUMENT THAT IS RETURNED (arch-review 65 P0) ──────
    //
    // The stage used to run ABOVE, on the lane's raw answer, while the canonical one was assembled here.
    // Two different documents: the K8s lane reports `{tenant, runId, externalJobId, namespace}` and the
    // attempt id, the verifier coordinate and the judged execution are joined from the reservation right
    // here. `VerifierReceipt.complete` requires exactly those three, so the same verifier execution read
    // `complete` in-line and `incomplete` after a crash — a difference in the RECORD produced by a
    // difference in whether this process survived.
    //
    // And the stage ran before the two checks above, so a verdict this process REFUSED for naming a
    // different container than it reserved was left on the stage for a restart to adopt.
    //
    // Canonical first, then durable, then the row. Each step is a precondition of the next.
    // A store fault here costs the RECOVERY, never the verdict: the answer is in hand and refusing the case
    // over a storage hiccup would trade a real measurement for a property only a crash would have needed.
    // Caught HERE rather than swallowed inside the stage, so the trade is made where it is visible — and
    // `verdict_produced` does not claim durability, so nothing downstream is misled by the loss.
    // …and staged, unless the lane already did it before reclaiming. A lane that acknowledged has made this
    // durable at the earlier, correct moment; one that did not gets the late stage it always had.
    if (acknowledged === undefined)
      await stageVerifierVerdict(deps.verdicts, {
        tenant: job.tenant,
        runId: job.runId,
        agentResultDigest: job.agentResultDigest,
        verifierAttemptId: attemptId,
        invocation: canonical,
      }).catch(() => undefined);
    // ── THE CAS IS THIS VERDICT'S RE-PROOF, AND IT IS NOT THE ADOPTION (arch-review 58 · 64) ───────
    //
    // Stamped as soon as the verdict is in hand: a row left live is compute a later sweep will chase, and
    // chasing a container that finished is how a cancellation stops converging.
    //
    // And the ANSWER is consumed, because `transition` is a conditional write and the one way it says `false`
    // here is the way that matters — something else made this attempt terminal while the verifier was judging,
    // which in practice means a cancellation revoked it. A verdict produced under an authority that was taken
    // back is not a measurement (rule `protocol` L1: the write that records the outcome is where the effect
    // re-proves its proof is still valid). The throw becomes `tests_pass: unmeasured` upstream, which says the
    // case was not judged — where a `1` would have said it passed.
    //
    // ⚠️ THE STATE THIS WROTE WAS `committed`, AND THAT WAS A DIFFERENT CLAIM. `committed` means "this
    // attempt's result is the case's answer", and at THIS line three later steps can still withhold it: the
    // merge can refuse the verdict as being about another workspace, the deferred collection can fail, a
    // speculative sibling can win the receipt. The correction for the first of those — flipping the row to
    // `superseded` — was refused by every real store, because `committed` is terminal and first-terminal-wins
    // (arch-review 64 P1-high).
    //
    // `verdict_produced` says what actually happened here: the bytes exist. The canonical settlement writes
    // `committed`, and from this state `superseded` is a write rather than a request.
    //
    // ⚠️ AND WHAT IT CLAIMS IS "A VERDICT WAS PRODUCED", NOT "RECOVERABLE BYTES EXIST" (arch-review 65
    // P0-lifecycle). Those are different facts and the state was documented as the second one, which it could
    // not prove: the stage swallowed its own failure and was a no-op on a deployment with no artifact store,
    // while this transition ran either way.
    //
    // The first repair attempt gated the transition on `stagedRef`, and that was WRONG in a way worth
    // recording: this CAS does two jobs. It moves the row off live, AND it re-proves that the authority which
    // reserved this work has not been revoked — a verdict produced under a cancelled batch is not a
    // measurement. Gating the whole thing on durability skipped the re-proof on every deployment that stages
    // nothing, so a revoked attempt's verdict became usable again. The suite said so immediately.
    //
    // So the CAS is unconditional and the CLAIM is narrowed to what it can always prove. Durability is not a
    // state, it is an ARTIFACT: `stagedRef` says whether one exists, recovery asks the store rather than the
    // row, and `readVerifierVerdict` answering `absent` is the same answer a row could have given — without a
    // second place for the two to disagree.
    if (!(await attempts.transition(attemptId, "verdict_produced"))) {
      const state = await attempts
        .list(storedExecutionId(job.runId))
        .then((rows) => rows.find((r) => r.attemptId === attemptId)?.state ?? "absent")
        // A ledger that cannot say whether the attempt settled has not said that it did (rule `protocol` L2).
        .catch(() => "unreadable");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { attemptId, state },
        `this verifier's attempt could not be settled (it is '${state}'), so the verdict it produced was not made under a live authorization`,
      );
    }
    return canonical;
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
