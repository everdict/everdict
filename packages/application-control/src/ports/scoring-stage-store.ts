import type { Score } from "@everdict/contracts";

// WHICH INVOCATION of "judge this case with this judge" a judgment came from — the authority token the
// stage arbitrates on. Ordered lexicographically: a later generation beats any attempt of an earlier one.
export interface JudgmentClaim {
  // The pass's LOGICAL ROUND ordinal (arch-review 16 P0-1). It was the workflow's continue-as-new count,
  // which was right while rotation was the only thing that produced a new activity execution — the replan
  // loop made every ROUND produce one, and Temporal's `attempt` restarts at 1 in each. The ordinal advances
  // on every new mutation opportunity; rotation merely carries it.
  generation: number;
  attempt: number; // Temporal's activity retry counter — within one execution
}

// Is `next` at least as current as `prior`? Written ONCE, so the two store impls and any future promotion
// cannot each invent their own ordering — the mistake that put an attempt-scoped number in charge of a
// pass-scoped row in the first place.
export function claimSupersedes(prior: JudgmentClaim | undefined, next: JudgmentClaim): boolean {
  if (prior === undefined) return true;
  return prior.generation !== next.generation ? prior.generation < next.generation : prior.attempt <= next.attempt;
}

// The claim an invocation with no rotations and no retries holds — the in-process pass.
export const INITIAL_CLAIM: JudgmentClaim = { generation: 0, attempt: 1 };

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
  // THE CLAIM this judgment was produced under (mig 0158/0159) — the token that says which invocation of
  // "judge this case with this judge" currently holds the right to write.
  //
  // It is a PAIR because one number cannot span the mutation it governs. `attempt` is Temporal's activity
  // retry counter, monotonic only WITHIN one activity execution; a stage row lives for the whole PASS, and
  // every new round — a replan inside one execution, or a continue-as-new — schedules the case as a NEW
  // execution starting at attempt 1 again, so an attempt-only token refused a legitimate new judgment as
  // stale and the pass could never finish that case. `generation` is the pass's LOGICAL ROUND ordinal,
  // carried in the workflow's INPUT so it stays deterministic, which makes (generation, attempt) monotonic
  // across the whole pass. Scoping it to rotations instead of rounds reopened the same hole one level down.
  //
  // Absent = the in-process pass, which has neither retries nor rotations to tell apart: (0, 1).
  claim?: JudgmentClaim;
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
// TWO AUTHORITIES, AT DIFFERENT STAGES OF THEIR LIFE (arch-review 15/16 — read this before changing anything
// here). Conflating them is what let a fail-open survive a review round, and a stale comment describing the
// earlier era is a specification bug waiting for the next refactor:
//
//   SCORE BYTES — still SHADOW. Writers dual-write here and onto the carriers, and the carriers remain the
//     source of truth. A rollback at any point loses nothing. The contract step promotes them and deletes
//     the strip.
//
//     ONE reader exists, and it is deliberately incapable of changing a record (arch-review 43 ①): under
//     `EVERDICT_SCORING_STAGE_AUTHORITATIVE=1` a settled pass rebuilds the plane it certifies by promoting
//     its staged delta onto the carriers (`promoteStagedJudgments`), but only where its own parity
//     observation says the two sources agree completely, and the promoted plane is re-digested against the
//     carrier plane before it is used. Anything else is REFUSED and recorded on the revision
//     (`stagePromotion`). That is the promotion's CODE being exercised on real traffic — the dimension no
//     amount of dual-write evidence covers, because until then the merge did not exist to be wrong. The
//     bytes' authority does not move; only the code path that would move it starts running.
//
//   CLAIM ARBITRATION — already AUTHORITATIVE, and production-critical. `stage()` decides which invocation
//     holds the right to write a given (case, judge), and the carrier write OBEYS that answer, per judge. A
//     failure here is therefore NOT best-effort: the caller must fail closed and write nothing, because
//     "the arbiter is unavailable" read as "you won" restores the very race this settles, at exactly the
//     moment it is least observable.
//
// LIFETIME: a pass's rows are cleared once its revision has recorded a DURABLE observation of them
// (`ScoringRevision.stageParity`, arch-review 16 P1-6) — never before, since that observation is the evidence
// the promotion decision rests on, and never "eventually", since the rows are one per
// (scorecard × pass × case × judge).
// What one pass's stage looked like against the plane it actually wrote (arch-review 10 P1). The contract
// step swaps the source of truth from the carriers to the stage, and the only honest basis for that swap is
// having watched the two agree on real traffic — dual-writing for a week proves nothing if nobody compared
// them. Reported per settled pass so a mismatch names the pass, not a daily aggregate nobody can trace back.
//
// This shape is the OBSERVATION; where it is kept is the point (arch-review 16 P1-6). It is written onto the
// settled `ScoringRevision` in the same guarded update as the revision itself, and only projected into
// process metrics afterwards. As a metric alone it could not be re-read per pass, and a control plane that
// died between the settle and the callback left the pass silently unobserved — indistinguishable from an
// agreeing one, in the evidence a promotion decision reads.
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
  // Drop a pass's stage. Called once the pass's revision carries its durable parity observation (settle) and
  // when a pass is declared dead (`failScore` — it will never write again); returns how many rows went, so a
  // caller can report what it collected instead of guessing. Never before the observation: clearing first
  // destroys exactly the evidence the promotion decision reads.
  clear(scorecardId: string, passId: string): Promise<number>;
}
