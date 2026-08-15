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
export async function openPhysicalAttempt(
  deps: { attempts?: ExecutionAttemptStore; recordings?: RecordingStore },
  input: OpenAttemptInput,
): Promise<PhysicalAttempt> {
  const { attempts, recordings } = deps;
  if (!attempts) {
    if (!recordings) return { unisolated: false };
    const generation = await recordings.open(input.executionId).catch(() => undefined);
    return generation === undefined ? { unisolated: true } : { generation, unisolated: false };
  }
  // The ledger write is the one thing that must not be swallowed silently into "no attempt happened" — but it
  // is still Phase-1 best-effort (nothing reads it), so a store fault degrades to the pre-ledger behaviour
  // rather than failing the dispatch.
  const opened = await attempts.open(input).catch(() => undefined);
  if (!opened) {
    if (!recordings) return { unisolated: false };
    const generation = await recordings.open(input.executionId).catch(() => undefined);
    return generation === undefined ? { unisolated: true } : { generation, unisolated: false };
  }
  if (!recordings) return { attemptId: opened.attemptId, generation: opened.generation, unisolated: false };
  const claimed = await recordings.open(input.executionId, opened.generation).catch(() => undefined);
  if (claimed === undefined) {
    await attempts.markUnisolated(opened.attemptId).catch(() => {});
    return { attemptId: opened.attemptId, unisolated: true };
  }
  return { attemptId: opened.attemptId, generation: claimed, unisolated: false };
}
