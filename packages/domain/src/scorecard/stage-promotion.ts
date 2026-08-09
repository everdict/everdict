// Whether a scoring pass's write-ahead STAGE may be promoted to the source of truth
// (docs/architecture/scoring-plane-revisions.md, the contract step).
//
// This lives in the DOMAIN, not on the store port (arch-review 12). A port says how to read and write a
// thing; "is this parity good enough to move the source of truth" is a pure policy decision over numbers,
// with no I/O and no storage knowledge — exactly the admission test the layer spine states. Keeping it on
// the port meant the one rule that gates an irreversible migration lived next to SQL helpers.

// What one pass's stage looked like against the plane it actually wrote. Reported per settled pass so a
// mismatch names the pass, not a daily aggregate nobody can trace back.
export interface ScoringStageParity {
  scorecardId: string;
  passId: string;
  // What this pass ACTUALLY JUDGED, derived from the settled plane rather than from the stage (arch-review
  // 11). A comparison that walks the staged rows can only report on the writes that SUCCEEDED, so a pass
  // that judged 100 cases and failed to stage 20 graphed as perfect parity over a 20% loss. The stage write
  // is best-effort by design, which is precisely why the measurement cannot be sourced from it.
  expectedJudged: number;
  staged: number;
  // Judged, but NOT in the stage. A promotion would silently drop these — the failure mode a stage-only
  // comparison is structurally blind to.
  missingFromStage: string[];
  // Of the staged rows, how many carry exactly the judgments the live plane ended up with.
  matched: number;
  // Cases whose staged judgment differs from the plane — the ones a promotion would have changed.
  mismatched: string[];
  // Staged for a case the plane has no row for at all. A promotion would INVENT a row here, which is why it
  // is counted apart from a plain value mismatch.
  orphaned: string[];
}

// The contract step's precondition, as code so nobody reconstructs it from a dashboard. `staged === matched`
// is NOT it: that holds trivially when nothing was staged, which is the exact failure being guarded against.
export function stagePromotionSafe(parity: ScoringStageParity): boolean {
  return (
    parity.expectedJudged === parity.staged &&
    parity.staged === parity.matched &&
    parity.missingFromStage.length === 0 &&
    parity.mismatched.length === 0 &&
    parity.orphaned.length === 0
  );
}
