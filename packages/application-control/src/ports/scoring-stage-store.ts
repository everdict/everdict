import type { Score } from "@everdict/contracts";

// ONE JUDGE'S judgment of ONE CASE, as a PASS staged it, before anyone can read it.
//
// Keyed per JUDGE, not per case (arch-review 12, mig 0153). Every other property of a judgment is per judge —
// `JudgeProgress`, the attempt budget, metric-family ownership, and now the retry itself — so a per-case row
// was the persistence layer disagreeing with the unit the domain actually mutates. It also could not express
// what the contract step needs: first-writer-wins would arbitrate a whole case (colliding two attempts that
// judged different judges), and a per-judge attempt CAS would have nowhere to live.
export interface StagedJudgment {
  caseKey: string; // caseId#trial — the key the score plane is addressed by
  judgeId: string; // the judge whose family these rows belong to
  // WHICH ATTEMPT produced it (mig 0158). Temporal retries an activity inside one pass, so two writes can
  // legitimately hold the same passId; the attempt number is what tells them apart, and it is monotonic per
  // activity execution — so the highest attempt IS the current one. Absent = 1 (the in-process pass, which
  // has no retry vocabulary).
  attempt?: number;
  // This judge's rows for this case: the verdict plus its criterion children. Never another judge's, and
  // never an inherited grader's — that is what makes the promotion's merge explicit.
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
// SEMANTICS — a staged row is THIS PASS'S JUDGMENT OF THIS CASE, and nothing else (arch-review 10 P1). The
// alternative reading ("the full desired score plane") was the one the expand step accidentally shipped: the
// strip-first step also wrote back, so a row appeared the moment a pass TOUCHED a case, whether or not it had
// judged it. `stage row exists → this case is done` is the obvious way to write the promotion, it would have
// been silently wrong, and the bug would have looked like a scoring bug rather than a semantics one. The
// delta reading also keeps the two provenances apart: what THIS pass produced vs what it inherited from the
// previous revision, which is the distinction the promotion has to make anyway.
//
// EXPAND STEP: writers dual-write here and onto the carriers; nothing DECIDES on this yet. The finalize reads
// the stage only to compare it against the carriers and report parity (see ScoringStageParity) — the evidence
// that has to exist before a promotion can be trusted, since dual-writing for a week proves nothing if nobody
// ever checked that the two agree. The contract step then makes the finalize promote from the stage and
// deletes the strip. Shipping the table first means a rollback at any point loses nothing.
// What one pass's stage looked like against the plane it actually wrote (arch-review 10 P1). The contract
// step swaps the source of truth from the carriers to the stage, and the only honest basis for that swap is
// having watched the two agree on real traffic — dual-writing for a week proves nothing if nobody compared
// them. Reported per settled pass so a mismatch names the pass, not a daily aggregate nobody can trace back.
export interface ScoringStageParity {
  scorecardId: string;
  passId: string;
  // What this pass ACTUALLY JUDGED, derived from the settled plane rather than from the stage — the whole
  // point (arch-review 11). The first version compared only the rows the stage happened to contain, so a
  // pass that judged 100 cases and failed to stage 20 of them reported 80 staged / 80 matched / 0 mismatched:
  // a perfect parity score describing a 20% data loss. A measurement that can only see what it wrote cannot
  // detect that something was not written, and the stage write is best-effort by design.
  expectedJudged: number;
  staged: number;
  // Judged, but NOT in the stage. A promotion would silently drop these — the failure mode a stage-only
  // comparison is structurally blind to.
  missingFromStage: string[];
  // Of the staged rows, how many carry exactly the judgments the live plane ended up with.
  matched: number;
  // Cases whose staged judgment differs from the plane — the ones a promotion would have changed.
  mismatched: string[];
  // Staged for a case the plane has no row for at all. A promotion would invent a row here.
  orphaned: string[];
}

export interface ScoringStageStore {
  // CLAIM one pass's judgments. The CURRENT ATTEMPT WINS per (scorecard, pass, case, judge) — a later
  // attempt supersedes an earlier one's row, and a late-completing earlier attempt is REFUSED
  // (arch-review 14 §11).
  //
  // First-writer-wins was the obvious fix and the wrong one: the first completion may belong to an attempt
  // the orchestrator has already timed out and replaced, so letting it win makes a judgment nobody was
  // waiting for into the record. Last-writer-wins — what the carrier did — has the mirror problem. The
  // question was never first-or-last; it is WHICH ATTEMPT HOLDS THE RIGHT TO WRITE, and Temporal's
  // monotonic attempt number already answers it.
  //
  // Returns the entries it ACCEPTED, because this is the arbitration the carrier write then follows: the
  // stage and the live plane must converge on ONE winner, and they can only do that if one of them decides
  // and the other obeys. A refused entry means "you were superseded" — the caller writes nothing.
  stage(scorecardId: string, passId: string, entries: StagedJudgment[]): Promise<StagedJudgment[]>;
  // Everything this pass staged — what a promotion reads.
  staged(scorecardId: string, passId: string): Promise<StagedJudgment[]>;
  // Drop a pass's stage. Called after a promotion and by the sweep that collects abandoned passes; returns
  // how many rows went, so a caller can report what it collected instead of guessing.
  clear(scorecardId: string, passId: string): Promise<number>;
}
