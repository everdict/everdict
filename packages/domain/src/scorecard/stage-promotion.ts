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
  // Did the comparison itself run (arch-review 13 P1)? A parity report that could not be produced — the
  // stage read threw, the store was gone — used to fire nothing at all, so an operator watching
  // `mismatched = 0` was watching a series that says the same thing whether every pass agreed or no pass was
  // ever checked. The suite's oldest rule applies to migration telemetry too: what was not observed is not
  // green. A `completed: false` report carries the reason and nothing else; it exists to be counted.
  completed: boolean;
  failure?: string;
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
  if (!parity.completed) return false; // an unmeasured pass is not a passing one
  return (
    parity.expectedJudged === parity.staged &&
    parity.staged === parity.matched &&
    parity.missingFromStage.length === 0 &&
    parity.mismatched.length === 0 &&
    parity.orphaned.length === 0
  );
}

// WHETHER THE FLEET MAY TAKE THE CONTRACT STEP — the aggregate over what passes actually observed.
//
// `stagePromotionSafe` answers it for ONE pass. The migration is a decision about all of them, and it has
// been carried across five reviews as "deferred pending observed real-traffic parity" — a precondition
// stated in prose, which means nobody could ever say whether it had been met. It is now a function over the
// durable observations (`ScoringRevision.stageParity`), so the answer comes from evidence rather than from
// somebody's reading of a dashboard.
//
// Two rules, both inherited from this suite's oldest one — NOT EVALUATED IS NEVER GREEN:
//
//   1. An UNOBSERVED pass is not a passing pass. A revision with no `stageParity` predates the observation
//      or ran with no stage wired; either way it is evidence of nothing, and counting it as agreement is how
//      "0 mismatches" comes to mean "0 comparisons".
//   2. ONE incomplete report blocks. A comparison that could not run is the case the operator most needs to
//      see, and averaging it away is the failure this whole field exists to prevent.
//
// `minimumObserved` is the caller's — how much traffic is enough is a product judgement, not a domain one.
export interface StagePromotionReadiness {
  // Every recorded observation, whatever it said.
  observed: number;
  // …of which agreed completely (`promotionSafe`).
  safe: number;
  // Revisions carrying no observation at all — the denominator that makes `safe` meaningful.
  unobserved: number;
  // Comparisons that could not run. Any of these blocks, regardless of the counts.
  incomplete: number;
  // The passes that disagreed, named — a promotion decision has to be traceable to the units that block it.
  blockedBy: Array<{ scorecardId?: string; passId?: string; reason: string }>;
  ready: boolean;
}

export function stagePromotionReadiness(
  revisions: ReadonlyArray<{
    scorecardId?: string;
    passId?: string;
    stageParity?: { completed: boolean; failure?: string; promotionSafe: boolean };
  }>,
  minimumObserved: number,
): StagePromotionReadiness {
  const blockedBy: StagePromotionReadiness["blockedBy"] = [];
  let observed = 0;
  let safe = 0;
  let unobserved = 0;
  let incomplete = 0;
  for (const revision of revisions) {
    const parity = revision.stageParity;
    if (parity === undefined) {
      unobserved += 1;
      continue;
    }
    observed += 1;
    if (!parity.completed) {
      incomplete += 1;
      blockedBy.push({
        ...(revision.scorecardId !== undefined ? { scorecardId: revision.scorecardId } : {}),
        ...(revision.passId !== undefined ? { passId: revision.passId } : {}),
        reason: parity.failure ?? "the parity comparison did not complete",
      });
      continue;
    }
    if (parity.promotionSafe) {
      safe += 1;
      continue;
    }
    blockedBy.push({
      ...(revision.scorecardId !== undefined ? { scorecardId: revision.scorecardId } : {}),
      ...(revision.passId !== undefined ? { passId: revision.passId } : {}),
      reason: "the staged judgments differ from the plane this pass settled",
    });
  }
  return {
    observed,
    safe,
    unobserved,
    incomplete,
    blockedBy,
    // Enough evidence, all of it clean. `minimumObserved` guards the trivial case the per-pass rule already
    // refuses one level down: a fleet that never staged anything agrees with itself perfectly.
    ready: observed >= minimumObserved && minimumObserved > 0 && blockedBy.length === 0,
  };
}
