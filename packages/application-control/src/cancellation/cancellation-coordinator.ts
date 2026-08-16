import type {
  CancellationCertificate,
  CancellationStore,
  CancellationTarget,
  CancellationTargetKind,
} from "../ports/cancellation-store.js";

// What a teardown answers when it ran to completion. `unactionable` is not a failure and not a convergence:
// the target is gone, or was never aborted, so there is nothing this operation could ever achieve by being
// retried — tearing down a LIVE target because a stale row names it would be the reconciler cancelling work
// nobody cancelled. Closing the row is the honest end.
//
// Not converged is a THROW, deliberately: the caller-facing path (a user's cancel request) must fail with
// it, and the sweep must leave the row owed with the reason recorded. One signal, two readers.
export type CancellationTeardownResult =
  | { kind: "converged"; certificate: CancellationCertificate }
  | { kind: "unactionable"; reason: string };

// The idempotent teardown for one kind of target, bound to the service that owns it. `targetId` is all it
// gets: everything else it needs it re-reads, because the row it is converging may have been written by a
// process that is no longer running.
export type CancellationTeardown = (targetId: string) => Promise<CancellationTeardownResult>;

// ── THE TEARDOWN AS A DURABLE OPERATION, FOR EITHER KIND (arch-review 47 §5.2, generalized in 52 Wave 3) ──
//
// The request→attempt→complete-or-fail wrapper the DECISION path runs, shared by both lanes so the batch and
// the standalone run cannot drift into two protocols. A store-less deployment gets exactly today's behavior:
// the teardown runs, a failure throws, the caller's retry converges.
export async function runDurableTeardown(
  deps: { cancellations?: CancellationStore; now: () => string },
  target: CancellationTarget,
  teardown: () => Promise<CancellationCertificate>,
): Promise<void> {
  const operations = deps.cancellations;
  if (!operations) {
    await teardown();
    return;
  }
  // RE-REQUEST, best-effort — the DURABLE request already rode the abort settle's own transaction
  // (`requestCancellation` on the settle), so this upsert only re-opens the row for the convergent-retry
  // path (a cancel of an already-terminal record, whose settle never ran) and for legacy records aborted
  // before the settle carried the pair. Its failure therefore degrades nothing new.
  await operations.request(target, deps.now()).catch((err: unknown) => {
    console.warn(
      `[cancellation] teardown re-request for ${target.kind} ${target.id} failed (the settle-time row, if any, still owns it): ${
        err instanceof Error ? err.message : err
      }`,
    );
  });
  let certificate: CancellationCertificate;
  try {
    certificate = await teardown();
  } catch (err) {
    // The 5xx keeps its meaning — the caller is still told the teardown did not finish. What changes is
    // that the caller is no longer the only one who can finish it.
    await operations.fail(target, err instanceof Error ? err.message : String(err), deps.now()).catch(() => undefined);
    throw err;
  }
  await operations.complete(target, deps.now(), certificate).catch(() => undefined);
}

// ── THE RECONCILER, FOR EVERY KIND OF TARGET ────────────────────────────────────────────────────────
//
// One sweep over one ledger. It knows nothing about batches or runs — it holds a teardown per kind and
// dispatches each owed row to the one that can converge it. The steps those teardowns re-run are the same
// idempotent ones a caller's retry runs (a fenced child settle that loses is a normal race result, a kill of
// a job that is already gone is `absent`, a queue drop that matches nothing removes nothing), so a
// reconciliation that overlaps a caller's own retry costs work, never correctness.
export class CancellationCoordinator {
  constructor(
    private readonly deps: {
      cancellations: CancellationStore;
      // Partial on purpose: a composition that wires only one lane sweeps only that lane, and rows of the
      // other kind are LEFT OWED rather than closed. Closing a row this process cannot converge would be
      // the same lie the whole ledger exists to prevent, one level up.
      teardowns: Partial<Record<CancellationTargetKind, CancellationTeardown>>;
      now: () => string;
    },
  ) {}

  // Re-run every teardown that is still owed. Called on a timer by the composition root (leader-gated — it
  // acts on rows this process does not own). Returns how many operations it CLOSED.
  async reconcile(limit = 50): Promise<number> {
    const { cancellations, teardowns, now } = this.deps;
    const owed = await cancellations.listIncomplete(limit);
    let closed = 0;
    for (const operation of owed) {
      const teardown = teardowns[operation.target.kind];
      if (!teardown) continue; // not ours to converge — another replica's coordinator owns this kind
      let result: CancellationTeardownResult;
      try {
        result = await teardown(operation.target.id);
      } catch (err) {
        // Stays owed, with the reason recorded. The next sweep tries again — this is the whole point of the
        // row, so a failure here is not escalated into the sweep's own failure (one stuck target must not
        // stop the reconciler from converging the others).
        await cancellations
          .fail(operation.target, err instanceof Error ? err.message : String(err), now())
          .catch(() => undefined);
        continue;
      }
      await cancellations
        .complete(operation.target, now(), result.kind === "converged" ? result.certificate : undefined)
        .catch(() => undefined);
      closed += 1;
    }
    return closed;
  }
}
