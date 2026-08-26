import type { CampaignFrame, CampaignRound } from "@everdict/contracts";

// ── THE PURE ADOPTION GATE (docs/architecture/evolution-lineage.md, Track D) ─────────────────────────
//
// One total function over the frozen frame and the append-only rounds — no I/O, no mutable counters: the
// rejected streak and the budget spend are DERIVED from the rounds, so the answer can never disagree with
// the trace that produced it. The service persists the answer as the campaign's close; a human approver
// approves THIS answer, not a summary the loop wrote about itself.
//
// `identity_unverified` is deliberately a per-decision refusal rather than a terminal state: the campaign
// stays open, because the fix (pin the image, run on a lane that reports provenance) is another round —
// whereas no_improvement and budget_exhausted are the campaign's own endings.

export type CampaignGateAnswer =
  | { kind: "adopt"; version: string; provingScorecardId: string; waivedAxes: string[] }
  | { kind: "continue"; roundsLeft: number; consecutiveRejected: number }
  | { kind: "halt"; reason: "no_improvement" | "budget_exhausted" | "identity_unverified"; detail: string };

// A round is a WIN only when its comparison actually held: a non-comparable pair produced no significance
// signal, and counts riding on it are not evidence.
function winning(round: CampaignRound): boolean {
  const v = round.verdict;
  return v.comparable && v.significantImprovements >= 1 && v.significantRegressions === 0;
}

export function campaignAdoption(frame: CampaignFrame, rounds: readonly CampaignRound[]): CampaignGateAnswer {
  const latest = rounds.at(-1);
  // Only the LATEST round's candidate is on the table: adoption is of the current variant, and a stale win
  // followed by a worse attempt is a loop that returns to the winner explicitly, never a gate doing
  // archaeology over the trace.
  if (latest !== undefined && winning(latest)) {
    const unverified = latest.verdict.unverifiedAxes;
    if (unverified.length > 0 && !frame.allowUnverifiedIdentity) {
      return {
        kind: "halt",
        reason: "identity_unverified",
        detail: `the winning round's comparison could not verify ${unverified.join(", ")} — an optimization verdict over an unverifiable world is refused unless the frame recorded the waiver at open`,
      };
    }
    return {
      kind: "adopt",
      version: latest.candidateVersion,
      provingScorecardId: latest.candidateScorecardId,
      // Waived axes are RECORDED on the answer, so the adoption that proceeds over them says so durably.
      waivedAxes: frame.allowUnverifiedIdentity ? [...unverified] : [],
    };
  }

  let consecutiveRejected = 0;
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    const r = rounds[i];
    if (r === undefined || winning(r)) break;
    consecutiveRejected += 1;
  }
  // The streak halt outranks the budget halt: "K straight rejections" names what is wrong (the hypothesis
  // well is dry), where "the budget ran out" only names when it stopped mattering.
  if (consecutiveRejected >= frame.stopAfterRejectedRounds) {
    return {
      kind: "halt",
      reason: "no_improvement",
      detail: `${consecutiveRejected} consecutive rounds were rejected (frame stops after ${frame.stopAfterRejectedRounds})`,
    };
  }
  if (rounds.length >= frame.budget.maxRounds) {
    return {
      kind: "halt",
      reason: "budget_exhausted",
      detail: `${rounds.length} of ${frame.budget.maxRounds} budgeted rounds are spent and the latest candidate is not adoptable`,
    };
  }
  return { kind: "continue", roundsLeft: frame.budget.maxRounds - rounds.length, consecutiveRejected };
}
