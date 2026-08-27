import { storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryIntermediateCleanupStore } from "../ports/intermediate-cleanup-store.js";
import { type ExecutionDisposition, RetainedMigrationSweeper } from "./retained-migration-sweeper.js";

// ── A ROW NO SETTLEMENT WILL EVER RELEASE (arch-review 71, migration) ───────────────────────────────
//
// `retained` means "a recovery may still need these bytes", and since arch-review 70/71 the release rides
// the settlement transaction, so a row written after that cannot get stuck. Rows written BEFORE it can: the
// settlement committed, the separate release call never ran, and `due()` correctly refuses to return a
// retained row. Those artifacts are kept forever by a reconciler working exactly as designed.
//
// ⚠️ AND THE DANGEROUS VERSION OF THIS FIX IS THE OBVIOUS ONE. A sweeper that flipped old rows on AGE alone
// would be a second release path with weaker evidence than the settlement's — and it would eventually delete
// the artifacts of a case that was simply running for a long time. So the sweeper decides nothing: it asks
// the ledger the SAME question the settlement answers, and an execution that is live, or one the ledger will
// not answer for, is left exactly as it is.
//
// Seen RED before the sweeper existed, observed:
//   a terminal execution's artifacts stayed unreleasable: expected 'retained' to be 'gc_owed'

const EXECUTION = storedExecutionId("evd-run-old");
const ref = (key: string) => ({ key, digest: `sha256:${key}` });

const stuck = async () => {
  const cleanup = new InMemoryIntermediateCleanupStore();
  await cleanup.owe({ tenant: "acme", executionId: EXECUTION, refs: [ref("agent-half/legacy.json")] });
  await cleanup.confirm({ tenant: "acme", executionId: EXECUTION, keys: ["agent-half/legacy.json"] });
  return cleanup;
};

const sweeper = (cleanup: InMemoryIntermediateCleanupStore, disposition: ExecutionDisposition) =>
  new RetainedMigrationSweeper({
    cleanup,
    dispositionOf: async () => disposition,
    minAgeMs: 0,
  });

describe("[R71 COUNTEREXAMPLE] a terminal execution's retained row is migrated, not stranded", () => {
  it("RELEASES a row whose execution the ledger says is terminal", async () => {
    const cleanup = await stuck();
    expect(cleanup.snapshot()[0]?.state, "the fixture did not start retained").toBe("retained");

    const tick = await sweeper(cleanup, { kind: "terminal" }).tick();

    expect(tick.released, "a terminal execution's artifacts stayed unreleasable").toBe(1);
    expect(cleanup.snapshot()[0]?.state).toBe("gc_owed");
    // …and it is now in the ORDINARY worklist, which is the whole point: a migrated row must be
    // indistinguishable from one a settlement freed.
    expect(await cleanup.due(new Date(Date.now() + 60_000).toISOString(), 50)).toHaveLength(1);
  });

  it("LEAVES a live execution alone, however old the row is", async () => {
    // The case that makes an age-only sweeper dangerous: a long-running case is legitimately retained, and
    // collecting its half is deleting the evidence its own recovery would need.
    const cleanup = await stuck();

    const tick = await sweeper(cleanup, { kind: "live", reason: "the run is running" }).tick();

    expect(tick.released, "a running case's artifacts were collected").toBe(0);
    expect(tick.live).toBe(1);
    expect(cleanup.snapshot()[0]?.state).toBe("retained");
  });

  it("LEAVES a row alone when the ledger will not say", async () => {
    // L2's third value. "We could not find out" is not a licence to collect, and the next tick asks again.
    const cleanup = await stuck();

    const tick = await sweeper(cleanup, { kind: "unknown", reason: "the run store is down" }).tick();

    expect(tick.unknown).toBe(1);
    expect(tick.released, "an unreadable ledger was treated as permission").toBe(0);
    expect(cleanup.snapshot()[0]?.state).toBe("retained");
  });

  it("treats a THROWN disposition as unknown rather than as an answer", async () => {
    const cleanup = await stuck();
    const tick = await new RetainedMigrationSweeper({
      cleanup,
      dispositionOf: async () => {
        throw new Error("the ledger is unreachable");
      },
      minAgeMs: 0,
    }).tick();

    expect(tick.unknown).toBe(1);
    expect(cleanup.snapshot()[0]?.state).toBe("retained");
  });

  it("does not look at rows a settlement has already released", async () => {
    // The control: this sweeper's worklist is `retained` only. A released row is the reconciler's, and two
    // owners for one row is how they drift.
    const cleanup = await stuck();
    await cleanup.releaseForGc("acme", EXECUTION);

    const tick = await sweeper(cleanup, { kind: "terminal" }).tick();

    expect(tick.scanned, "the migration sweeper claimed a row the reconciler already owns").toBe(0);
  });
});
