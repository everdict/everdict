import type { ExecutionDisposition, RunStore } from "@everdict/application-control";
import type { ExecutionAttemptRecord, ExecutionId, RunRecord } from "@everdict/contracts";
import { TERMINAL_RUN_STATUSES, isTerminalAttemptState } from "@everdict/contracts";

// ── A PHYSICAL ATTEMPT'S END IS NOT THE CASE'S END (arch-review 76 P1) ──────────────────────────────
//
// The legacy-retained sweeper answers one question — may these intermediates be collected — and it has been
// wrong twice in different directions. First it answered `unknown` for every batch coordinate, so the lane
// where most of the leak lives was never migrated. Then it read the attempt ledger and treated
// `attempts.every(isTerminalAttemptState)` as "the case is over", which is a different sentence:
//
//     failed       THIS physical attempt ended in a failure of its own
//     superseded   another attempt owns the case, or this one was abandoned
//
// Both are terminal for the ROW and say nothing about the case. The ledger exists precisely to record
// several physical attempts per case — retries, spillover, speculation — so there is always a moment where
// every attempt recorded so far is terminal and the replacement has not opened yet:
//
//     attempt #1 failed · attempt #2 not yet opened · child still running
//     → every attempt terminal → collect → the retry's artifacts are gone
//
// So the certificate needs the LOGICAL side too, and the attempt row already carries the coordinate for it
// (`childRunId`) — no parsing of a rendered execution id, which is what rule `protocol` L3 forbids and what
// a scorecard id full of its own dashes makes impossible anyway.
//
// It is a named function rather than a closure in `main.ts` because a closure there is production code no
// test can reach — the reason `buildCampaignAdoption` and the durability policy are named too.

// What the disposition rests on, structurally, so this file depends on a read rather than on a whole store.
export interface RetainedDispositionDeps {
  runs: Pick<RunStore, "get">;
  // Absent = this deployment has no attempt ledger, which makes every batch coordinate `unknown` rather
  // than collectable. Saying so is the fail-closed answer; guessing is not.
  attempts?: { list(executionId: ExecutionId): Promise<ExecutionAttemptRecord[]> };
}

const STANDALONE = "evd-run-";

export function retainedDispositionOf(deps: RetainedDispositionDeps) {
  return async (_tenant: string, executionId: ExecutionId): Promise<ExecutionDisposition> => {
    // A standalone execution id is `evd-run-<record id>` — the ONE derivation, read back rather than
    // re-spelled. Its run row IS the logical outcome, so nothing further is needed.
    if (executionId.startsWith(STANDALONE)) return await runDisposition(deps, executionId.slice(STANDALONE.length));

    if (deps.attempts === undefined) return { kind: "unknown", reason: "no attempt ledger to ask about a batch case" };
    const listed = await deps.attempts.list(executionId).then(
      (rows) => ({ ok: true as const, rows }),
      () => ({ ok: false as const, rows: [] as ExecutionAttemptRecord[] }),
    );
    if (!listed.ok) return { kind: "unknown", reason: "the attempt ledger did not answer" };
    // NO ROWS IS NOT "GONE". An execution this ledger never recorded may predate the ledger entirely, and
    // collecting on that is a certificate over compute nobody observed (L5).
    if (listed.rows.length === 0)
      return { kind: "unknown", reason: "the attempt ledger holds nothing for this execution" };
    // Necessary, not sufficient: a live attempt settles it immediately, and all-terminal only moves the
    // question to the child.
    if (!listed.rows.every((a) => isTerminalAttemptState(a.state)))
      return { kind: "live", reason: "an attempt for this execution is still open" };

    // …and the LOGICAL half. Every terminal attempt names the child run it was for; the child's status is
    // the case's own outcome, and it is what tells a finished case from one between retries.
    const children = [...new Set(listed.rows.flatMap((a) => (a.childRunId !== undefined ? [a.childRunId] : [])))];
    if (children.length === 0)
      return { kind: "unknown", reason: "no attempt for this execution names the child run it ran" };
    const dispositions = await Promise.all(children.map((child) => runDisposition(deps, child)));
    // Fail-closed folding, in the order that matters: any unknown makes the whole answer unknown (we could
    // not find out), any live keeps it owed, and only an all-terminal set is a licence to collect.
    const unknown = dispositions.find((d) => d.kind === "unknown");
    if (unknown !== undefined) return unknown;
    const live = dispositions.find((d) => d.kind === "live");
    if (live !== undefined) return live;
    return { kind: "terminal" };
  };
}

async function runDisposition(deps: RetainedDispositionDeps, id: string): Promise<ExecutionDisposition> {
  // NOT `.catch(() => undefined)` collapsed into absence: a ledger that would not answer and a run that is
  // gone are different states, and only one of them is a licence to collect (L2).
  const read = await deps.runs.get(id).then(
    (record: RunRecord | undefined) => ({ ok: true as const, record }),
    () => ({ ok: false as const, record: undefined }),
  );
  if (!read.ok) return { kind: "unknown", reason: "the run ledger did not answer" };
  if (read.record === undefined) return { kind: "unknown", reason: "no such run — this row names nothing we own" };
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(read.record.status)
    ? { kind: "terminal" }
    : { kind: "live", reason: `the run is ${read.record.status}` };
}
