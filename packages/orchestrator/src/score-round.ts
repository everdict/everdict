// The scoring pass's ROUND DECISION, as a pure total function (arch-review 15 P1-6).
//
// It lives here, beside the workflow rather than in `@everdict/domain`, because workflow code may only import
// its own package locally and types from ours — and it lives OUTSIDE `workflows.ts` because a decision that
// can only be exercised by standing up a Temporal test environment is a decision nobody exercises. Pure,
// deterministic, and therefore safe to bundle into the workflow.
//
// What it decides is when a pass is allowed to STOP. That question used to be answered by
// `plan.keys.length > limit` — the size of the batch — which meant a case's right to a retry depended on how
// many other cases happened to be next to it:
//
//   601 cases, one judge times out  → the plan exceeded the slice → rotate → re-plan → the case is retried
//     2 cases, one judge times out  → the plan fit in one slice   → finalize → the case is unmeasured forever
//
// A pass finishes when the worklist is EMPTY. Everything else is a bound the loop owns.
//
// It also owns the pass's LOGICAL ROUND ORDINAL (arch-review 16 P0-1) — see `ScoreRoundState.round`. Rounds
// and rotations were the same number until the replan loop made them different things.

export interface ScoreRoundState {
  // The worklist size this pass last planned. `undefined` = no round has planned yet.
  remaining?: number;
  // Consecutive rounds that failed to shrink the worklist.
  stalled: number;
  // THE LOGICAL ROUND ORDINAL — the pass-global half of the judgment claim (arch-review 16 P0-1).
  //
  // It was the workflow's continue-as-new count, which was right for the rotation boundary and wrong for
  // everything the replan loop then added. Each round schedules a NEW activity execution, and Temporal's
  // `attempt` restarts at 1 in a new execution — so inside ONE workflow execution:
  //
  //   round 0  activity X  attempt 1 timeout, attempt 2 → retryable_unmeasured   stage = (0, 2)
  //   round 1  activity Y  attempt 1 → measured PASS                             claim = (0, 1) → REFUSED
  //
  // The case can then never finish, and the stall guard eventually abandons it — so the replan loop's whole
  // benefit was cancelled for exactly the retry it exists to serve. The generation must advance on every new
  // logical MUTATION OPPORTUNITY, not merely on workflow rotation; rotation only CARRIES it.
  round: number;
}

export type ScoreRoundDecision =
  // Nothing pending — the only clean finish.
  | { kind: "finish" }
  // History pressure: drain and continue as a new execution, carrying the stall state so rotating cannot
  // launder a pass that is making no progress into a fresh budget.
  | { kind: "rotate"; state: ScoreRoundState }
  // The worklist stopped shrinking. Settle, and SAY so — "we stopped retrying" is not "there was nothing
  // left to do", and a bare finalize can only express the second.
  | { kind: "abandon"; abandoned: number }
  // Run this slice, then ask again.
  | { kind: "execute"; keys: string[]; state: ScoreRoundState };

// How many consecutive rounds may move NOTHING off the worklist before the pass stops re-planning. The loop's
// termination must be owned by the loop, never inferred from what the activities are believed to write: a case
// whose id is absent from the effective dataset is skipped by the judge stream WITHOUT leaving a row, so its
// judge progress stays `absent` and no attempt budget ever binds. An unguarded "replan until empty" would
// re-plan it forever, and judging is provider calls — so it would bill forever.
//
// The value is DERIVED, not chosen. A retryable judgment legitimately keeps its case on the worklist for a
// whole retry budget: a one-case group whose judge fails twice and then measures plans the very same single
// key three rounds running, and every one of those rounds is progress the attempt counter can see even though
// the worklist size cannot. So the guard has to dominate `MAX_JUDGE_ATTEMPTS_PER_PASS` (@everdict/domain) —
// after that many attempts a still-failing judge goes `terminal_unmeasured` and the worklist HAS to shrink,
// so anything beyond it is a worklist that cannot shrink at all.
//
// It is restated rather than imported because workflow code may only import `@temporalio/workflow` plus TYPES
// from our packages (the bundle must stay deterministic). `score-round.test.ts` imports the domain constant
// and fails if this stops dominating it, so the coupling is checked rather than remembered.
export const MAX_STALLED_SCORE_ROUNDS = 4;

export function decideScoreRound(
  plannedKeys: readonly string[],
  state: ScoreRoundState,
  // Whether Temporal's history pressure says this execution should rotate. Passed in so the decision stays
  // pure; the workflow reads `workflowInfo()`, which is itself replay-deterministic.
  rotationDue: boolean,
  sliceLimit: number,
  maxStalledRounds: number = MAX_STALLED_SCORE_ROUNDS,
): ScoreRoundDecision {
  if (plannedKeys.length === 0) return { kind: "finish" };
  // Rotation is decided BEFORE the stall accounting, so a round that rotates without executing anything is
  // never charged a stall it had no chance to avoid.
  if (rotationDue) return { kind: "rotate", state };
  // `>=`, not `>`: a worklist that GREW is not progress either.
  const stalled = state.remaining !== undefined && plannedKeys.length >= state.remaining ? state.stalled + 1 : 0;
  if (stalled >= maxStalledRounds) return { kind: "abandon", abandoned: plannedKeys.length };
  return {
    kind: "execute",
    keys: plannedKeys.slice(0, Math.max(1, sliceLimit)),
    // The round advances HERE, with the decision to execute — one new round is one new set of activity
    // executions, which is exactly one new mutation opportunity for every key in it.
    state: { remaining: plannedKeys.length, stalled, round: state.round + 1 },
  };
}
