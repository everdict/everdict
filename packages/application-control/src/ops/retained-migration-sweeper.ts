import type { ExecutionId } from "@everdict/contracts";
import type { IntermediateCleanupStore } from "../ports/intermediate-cleanup-store.js";

// ── THE ROWS NO SETTLEMENT WILL EVER RELEASE (arch-review 71, migration) ────────────────────────────
//
// `retained` means "a recovery may still need these bytes", and since arch-review 70/71 the release rides
// the settlement transaction — so a row written after that change cannot get stuck. Rows written BEFORE it
// can: their settlement committed, the separate release call never ran, and `due()` correctly refuses to
// return a retained row. They are kept forever by a reconciler working exactly as designed.
//
// ⚠️ THIS IS A MIGRATION AND A CRASH REPAIR, NOT THE MECHANISM — the distinction the review that asked for
// it drew, and it decides the shape. A sweeper that flipped old rows on AGE alone would be a second release
// path with weaker evidence than the settlement's, and it would eventually delete the artifacts of a case
// that was legitimately still running. So this one decides nothing on its own: it asks the SAME question the
// settlement answers — is this execution terminal, with no contributing attempt still open — and only then
// hands the row to the ordinary release.
//
// A run that is still open, or a ledger that will not say, is left alone. "We could not find out" is not a
// licence to collect (rule `protocol` L2/L5).
export type ExecutionDisposition =
  | { kind: "terminal" } // settled, and nothing is still driving it — the release simply never ran
  // Still open, or an attempt is still working: these bytes are load-bearing. `reason` because a sweep that
  // leaves a row alone should be able to say WHY — "the run is running" and "an attempt is still open" are
  // different worlds, and an operator reading a row that never converges needs to tell them apart
  // (arch-review 76).
  | { kind: "live"; reason: string }
  | { kind: "unknown"; reason: string }; // the ledger would not say — leave it exactly as it is

export interface RetainedMigrationSweeperDeps {
  cleanup: IntermediateCleanupStore;
  // The ledger's own answer about one execution. Injected rather than reached for: this package owns no
  // store, and the sweeper must read the same truth the settlement did rather than a convenient proxy.
  dispositionOf: (tenant: string, executionId: ExecutionId) => Promise<ExecutionDisposition>;
  // How old a retained row must be before it is even a candidate. A live case is legitimately retained for
  // as long as it runs, so anything recent is a case in flight rather than a leak.
  minAgeMs?: number;
  batch?: number;
  now?: () => string;
}

export interface RetainedSweepTick {
  scanned: number;
  released: number;
  live: number;
  unknown: number;
}

export class RetainedMigrationSweeper {
  constructor(private readonly deps: RetainedMigrationSweeperDeps) {}

  async tick(): Promise<RetainedSweepTick> {
    const now = this.deps.now ?? (() => new Date().toISOString());
    const olderThan = new Date(Date.parse(now()) - (this.deps.minAgeMs ?? 24 * 60 * 60 * 1000)).toISOString();
    const candidates = await this.deps.cleanup.staleRetained(olderThan, this.deps.batch ?? 100);
    let released = 0;
    let live = 0;
    let unknown = 0;
    for (const debt of candidates) {
      const disposition = await this.deps.dispositionOf(debt.tenant, debt.executionId).catch(
        (err: unknown): ExecutionDisposition => ({
          kind: "unknown",
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      switch (disposition.kind) {
        case "live":
          live += 1;
          continue;
        case "unknown":
          // Deliberately silent about the row: an unreadable ledger is the one state where doing nothing is
          // the whole correct behaviour, and the next tick asks again.
          unknown += 1;
          continue;
        case "terminal": {
          // …and through the ORDINARY release, so a migrated row is indistinguishable from one a settlement
          // freed. A second write path here is how the two would drift.
          const freed = await this.deps.cleanup.releaseForGc(debt.tenant, debt.executionId);
          if (freed !== undefined) released += 1;
          continue;
        }
      }
    }
    return { scanned: candidates.length, released, live, unknown };
  }
}
