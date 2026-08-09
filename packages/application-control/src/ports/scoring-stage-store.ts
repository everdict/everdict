import type { Score } from "@everdict/contracts";

// One case's judgments as a PASS staged them, before anyone can read them.
export interface StagedScores {
  caseKey: string; // caseId#trial — the key the score plane is addressed by
  scores: Score[];
}

// The scoring STAGE (docs/architecture/scoring-plane-revisions.md) — a per-pass write-ahead area for the
// judgments a scoring pass produces, before the finalize promotes them onto the live plane.
//
// Why this exists: today reader and writer share one mutable structure (the child run rows), and every guard
// around scoring is a consequence of that single fact — the pass marker says "the plane is mid-rewrite", the
// strip-first step clears the previous pass's output, the child-write fence keeps a superseded writer out,
// artifacts are pass-keyed because two passes freeze bundles for one revision, and the settle is a CAS. Stage
// the judgments per pass and a stale writer's output lands somewhere nobody points at: not a hazard to defend
// against, just garbage to collect. The guards become unnecessary rather than more carefully maintained.
//
// Keyed by (scorecard, pass, case) so two passes targeting the same revision cannot see each other's work —
// the same reason the analysis artifact is keyed by pass and not by the revision it hopes to become.
//
// EXPAND STEP: writers dual-write here and onto the carriers; nothing READS this yet. The contract step makes
// the finalize promote from the stage and deletes the strip. Shipping the table first means a rollback at any
// point loses nothing, which is the whole reason the migration is split.
export interface ScoringStageStore {
  // Stage one pass's judgments for a set of cases. Idempotent per (scorecard, pass, case) — an activity retry
  // re-stages the same rows rather than accumulating duplicates.
  stage(scorecardId: string, passId: string, entries: StagedScores[]): Promise<void>;
  // Everything this pass staged — what a promotion reads.
  staged(scorecardId: string, passId: string): Promise<StagedScores[]>;
  // Drop a pass's stage. Called after a promotion and by the sweep that collects abandoned passes; returns
  // how many rows went, so a caller can report what it collected instead of guessing.
  clear(scorecardId: string, passId: string): Promise<number>;
}
