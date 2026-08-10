import { describe, expect, it } from "vitest";
import { MAX_STALLED_SCORE_ROUNDS, type ScoreRoundState, decideScoreRound } from "./score-round.js";

const fresh: ScoreRoundState = { stalled: 0 };

describe("decideScoreRound — a pass finishes when the worklist is empty, not when the batch is small", () => {
  it("a plan that fits inside one slice is EXECUTED, not treated as the last word", () => {
    // The regression this closes: the old rule finalized whenever `plan.keys.length <= limit`, so a two-case
    // batch whose judge timed out settled with that case unmeasured forever, while the identical failure in a
    // 601-case batch was retried — because the bigger plan happened to overflow the slice and force a re-plan.
    // Batch size was deciding a case's right to a retry; the judge attempt budget was written to decide it.
    const decision = decideScoreRound(["c1#0", "c2#0"], fresh, false, 500);
    expect(decision.kind).toBe("execute");
    if (decision.kind !== "execute") return;
    expect(decision.keys).toEqual(["c1#0", "c2#0"]);
    expect(decision.state).toEqual({ remaining: 2, stalled: 0 });
  });

  it("only an EMPTY plan finishes the pass", () => {
    expect(decideScoreRound([], fresh, false, 500)).toEqual({ kind: "finish" });
    // …and an empty plan finishes even when the history says rotate: there is nothing left to continue for.
    expect(decideScoreRound([], { remaining: 9, stalled: 1 }, true, 500)).toEqual({ kind: "finish" });
  });

  it("takes only a slice at a time and reports the FULL remaining count as the progress yardstick", () => {
    const decision = decideScoreRound(["a", "b", "c"], fresh, false, 2);
    if (decision.kind !== "execute") throw new Error(decision.kind);
    expect(decision.keys).toEqual(["a", "b"]);
    // Progress is measured against the whole worklist, never against the slice — otherwise every round would
    // look like a stall the moment the plan exceeded one slice.
    expect(decision.state.remaining).toBe(3);
  });

  it("resets the stall counter as soon as the worklist shrinks", () => {
    const decision = decideScoreRound(["a", "b"], { remaining: 5, stalled: 1 }, false, 500);
    if (decision.kind !== "execute") throw new Error(decision.kind);
    expect(decision.state.stalled).toBe(0);
  });

  it("counts a stall when the worklist fails to shrink — and when it GROWS", () => {
    const held = decideScoreRound(["a", "b"], { remaining: 2, stalled: 0 }, false, 500);
    if (held.kind !== "execute") throw new Error(held.kind);
    expect(held.state.stalled).toBe(1);
    // `>=`, not `>`: a worklist that grew is not progress either, and treating it as progress would let a pass
    // that keeps discovering work loop without ever tripping the guard.
    const grew = decideScoreRound(["a", "b", "c"], { remaining: 2, stalled: 0 }, false, 500);
    if (grew.kind !== "execute") throw new Error(grew.kind);
    expect(grew.state.stalled).toBe(1);
  });

  it("ABANDONS after consecutive stalled rounds instead of re-planning forever", () => {
    // Why a bound at all: a case whose id is absent from the effective dataset is skipped by the judge stream
    // WITHOUT leaving a row, so its judge progress stays `absent` and the per-judge attempt budget never
    // engages. "Replan until empty" would re-plan it forever — and judging is provider calls, so forever bills.
    const decision = decideScoreRound(["stuck"], { remaining: 1, stalled: MAX_STALLED_SCORE_ROUNDS - 1 }, false, 500);
    expect(decision).toEqual({ kind: "abandon", abandoned: 1 });
  });

  it("charges no stall to a round that rotates before it could execute anything", () => {
    // Rotation is decided first on purpose. Charging a stall to a round that never ran a case would let two
    // rotations in a row abandon a perfectly healthy pass.
    const decision = decideScoreRound(["a"], { remaining: 1, stalled: MAX_STALLED_SCORE_ROUNDS - 1 }, true, 500);
    expect(decision).toEqual({ kind: "rotate", state: { remaining: 1, stalled: MAX_STALLED_SCORE_ROUNDS - 1 } });
  });

  it("carries the stall state through rotation, so rotating cannot launder a stuck pass", () => {
    const atTheEdge = { remaining: 1, stalled: MAX_STALLED_SCORE_ROUNDS - 1 };
    const rotate = decideScoreRound(["stuck"], atTheEdge, true, 500);
    if (rotate.kind !== "rotate") throw new Error(rotate.kind);
    expect(rotate.state).toEqual(atTheEdge); // verbatim — a rotation is not a fresh budget
    // The continuation resumes from exactly this state and trips the guard on its own first round.
    expect(decideScoreRound(["stuck"], rotate.state, false, 500)).toEqual({ kind: "abandon", abandoned: 1 });
  });
});
