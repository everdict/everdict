import { InternalError, UpstreamError, attemptIdOf } from "@everdict/contracts";
import type { ExecutionAttemptStore, OpenAttemptInput } from "../ports/execution-attempt-store.js";
import type { RecordingStore } from "../ports/recording-store.js";

// What an opened physical execution knows about itself.
export interface PhysicalAttempt {
  // The recording coordinate the job may stamp. ABSENT means the producers carry none — the fail-closed
  // lane, unchanged: they stamp 0, the recording fence refuses them, and the case runs knowing its replay is
  // not canonical.
  generation?: number;
  // The ledger row's id, when the ledger is wired. Present even when `generation` is not: the attempt
  // happened either way, and that is the whole reason the ledger exists.
  attemptId?: string;
  unisolated: boolean;
}

// ── WHICH ATTEMPT A DISPATCHED JOB IS (arch-review 51) ───────────────────────────────────────────────
//
// One reading of the coordinate, for every lane that has a job in its hand and needs the ledger row it names.
// The carried id WINS: it is what the open actually returned, and it is present exactly in the case the
// derivation cannot serve — an UNISOLATED attempt, whose row exists under a generation the recording fence
// refused to hand back. Where a generation IS carried, the derivation is not a guess: `open` mints the
// ordinal and the row's id is `attemptIdOf(executionId, generation)` by construction, so the two agree.
//
// Absent means absent: no carried name and no generation is an execution whose attempt nobody opened (no
// ledger wired), and inventing a coordinate there would address somebody else's row.
export function jobAttemptId(
  job: { attemptId?: string; recordingGeneration?: number },
  executionId: string,
): string | undefined {
  if (job.attemptId !== undefined) return job.attemptId;
  return job.recordingGeneration === undefined ? undefined : attemptIdOf(executionId, job.recordingGeneration);
}

// ── ONE VERB FOR "A PHYSICAL EXECUTION BEGINS" (arch-review 42, Three-Ledger Phase 1) ────────────────
//
// Six call sites used to open an attempt, each by calling the recording store directly and each with its own
// spelling of the fail-closed rule. The rule is now stated once, here, because the two stores have to be
// opened in a fixed order and that order is not obvious from either one:
//
//   ① the ATTEMPT LEDGER mints the ordinal (it is the authority — see ExecutionAttemptStore), and
//   ② the RECORDING STORE claims exactly that coordinate.
//
// A recording claim that fails does NOT cancel the attempt. The execution is about to happen; what it lost
// is its fence. So the ledger row stays, marked `unisolated`, and the returned `generation` is stripped —
// which preserves byte-for-byte the behaviour every caller already had (`recordingStore.open().catch(() =>
// undefined)` → no `recordingGeneration` on the job → producers stamp 0 → refused). The difference is that
// the attempt is now RECORDED as having run unisolated instead of leaving no trace at all.
//
// With no ledger wired, the recording store self-mints exactly as before and no row is written.
// ── AND WHICH LANE IS ASKING (arch-review 54, Phase 1) ──────────────────────────────────────────────
//
// The degrade below is right for one lane and catastrophic for the other, and until now it could not tell
// them apart.
//
// A lane that runs the harness INSIDE this process (the CLI, a diagnostic run) loses only its recording fence
// when the ledger is unreachable: the execution still happens where we can see it, and refusing to run would
// trade a missing audit row for a missing result. That degrade stays.
//
// A MANAGED lane is about to ask an orchestrator to create a job that outlives this process. Its whole
// relationship with that job is the identity it writes down first — every stop, adoption, log tail and
// cancellation reaches for the handle stored on the attempt row. Handing that lane `{ unisolated: true }` with
// no `attemptId` does not degrade the audit trail; it authorises untracked compute, because the next thing the
// caller does is dispatch. `managed: true` says "I am going to place external work", and the answer to a
// ledger outage there is a refusal (rule `protocol` L1).
export async function openPhysicalAttempt(
  deps: { attempts?: ExecutionAttemptStore; recordings?: RecordingStore; managed?: boolean },
  input: OpenAttemptInput,
): Promise<PhysicalAttempt> {
  const { attempts, recordings, managed } = deps;
  // A managed dispatch with NO ledger wired at all is a composition error, not a runtime degrade: nothing in
  // that deployment can ever address the work it is about to create.
  if (managed === true && !attempts)
    throw new InternalError(
      "NOT_CONFIGURED",
      { executionId: input.executionId },
      "a managed dispatch needs an execution-attempt ledger — there is nowhere to record where the work will be placed.",
    );
  if (!attempts) {
    if (!recordings) return { unisolated: false };
    const generation = await recordings.open(input.executionId).catch(() => undefined);
    return generation === undefined ? { unisolated: true } : { generation, unisolated: false };
  }
  // A ledger fault must NOT fall back to the recording store's self-mint (arch-review 47 P0-4): with the
  // ledger wired, the ledger is the ONLY ordinal authority — a self-mint during its outage re-activates the
  // two-MAX+1 split the wiring exists to end. Concretely: attempt A minted g1 on the ledger but its
  // recording claim failed (ledger row, no recording row); a ledger outage during attempt B would let the
  // recording store mint MAX(empty)+1 = g1 again, and B's evidence/receipt/trajectory would then NAME A's
  // ledger identity. So the outage degrades this attempt to UNFENCED — no generation, no row, the same
  // fail-closed lane a refused recording claim takes — never to a coordinate another authority owns.
  const opened = await attempts.open(input).catch((err: unknown) => {
    // The managed lane's outage is not survivable: see the note above `openPhysicalAttempt`.
    if (managed === true)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { executionId: input.executionId },
        `the execution-attempt ledger could not open an attempt, so this dispatch has no durable identity to place work under: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    return undefined;
  });
  if (!opened) return { unisolated: true };
  if (!recordings) return { attemptId: opened.attemptId, generation: opened.generation, unisolated: false };
  const claimed = await recordings.open(input.executionId, opened.generation).catch(() => undefined);
  if (claimed === undefined) {
    await attempts.markUnisolated(opened.attemptId).catch(() => {});
    return { attemptId: opened.attemptId, unisolated: true };
  }
  return { attemptId: opened.attemptId, generation: claimed, unisolated: false };
}
