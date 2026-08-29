// ── A SWEEP THAT COULD NOT RUN IS NOT A SWEEP THAT REMOVED NOTHING (arch-review 120) ────────────────
//
// Both retention sweeps in the composition root were spelled:
//
//     const removed = await store.deleteOlderThan(cutoff).catch(() => 0);
//     if (removed > 0) console.log(`▶ … removed ${removed} …`);
//
// so a database or object-store outage produced the same observable as "nothing was old enough": zero, and
// silence, every hour, forever. `.catch(() => 0)` is the collapse rule `protocol` L2 bans by name — a read
// that failed is a THIRD value, not an empty answer — and the comment above the first sweep claimed
// "logged — evidence never leaves silently" while what left silently was the failure.
//
// It began to matter more when trajectory retention started deleting payload OBJECTS before the rows that
// name them: that sweep THROWS on an object-store refusal, deliberately, so the rows survive and the next
// pass can still enumerate what it owes. A caller that swallows the throw turns a fail-closed design back
// into the silent orphan it was written to prevent.
//
// One owner rather than a closure per sweep, for the sibling-lane reason: two sweeps written alike, one
// taught and one not, is how this repository's most common defect starts.
// ⚠️ WHY THIS IS NOT `ReadResult<number>` (design review). `@everdict/contracts` already owns the
// three-valued "it happened / it is not there / I could not find out", with `readOk`/`readUnknown`, and a
// second spelling of a kernel concept has to justify itself or it is drift (rule `protocol` L3). Two
// reasons it stays separate: a sweep is an EFFECT, so `kind: "read"` carrying "removed 42 rows" misnames
// what happened at the one place a reader looks; and `absent` has no meaning for a delete that always has a
// count. What is borrowed is the part that matters — the failure arm is a KIND, and `reason` is an operator
// diagnostic that no control flow may pattern-match on.
export type RetentionSweepOutcome =
  // The store answered. `removed` may legitimately be 0 — nothing was old enough.
  | { kind: "swept"; removed: number }
  // We could not find out. NEVER collapsed into `removed: 0`: the debt stays owed, the interval retries, and
  // an operator can see the difference.
  | { kind: "failed"; reason: string };

export async function runRetentionSweep(
  cutoffIso: string,
  deleteOlderThan: (cutoffIso: string) => Promise<number>,
): Promise<RetentionSweepOutcome> {
  try {
    return { kind: "swept", removed: await deleteOlderThan(cutoffIso) };
  } catch (err) {
    // Not rethrown: the caller is a periodic interval, and an unhandled rejection there takes the process
    // down. The interval IS the retry; this call's job is to answer which of the two things happened.
    return { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}
