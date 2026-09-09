import type { CampaignEvaluation, CampaignRound } from "@everdict/contracts";

// ── WHAT A CAMPAIGN'S EVALUATION BUDGET WAS ACTUALLY SPENT ON (review 2026-09-09 R2) ────────────────
//
// `budget.maxRounds` is spent by RESERVATIONS, not by rounds. The reservation door counts attempts; the
// adoption gate counted `rounds.length`. Both numbers are called "the budget" and they are not the same
// number, so a campaign whose sole attempt was reserved and then never reported sat in a state with no exit:
// the door refused a second reservation ("evaluation budget is exhausted") while the gate answered
// `continue` with a round still left, and `settle` refuses `continue`. Nothing could progress it and nothing
// could close it.
//
// The conservative half of that — a spent reservation stays spent — is right and stays. What was missing is
// its CONSEQUENCE: an ending has to be able to fire on the ledger the door reads. So the spend is one owner
// here, consumed by the gate, by the write-side refusal and by the reservation itself (rule `protocol` L3 —
// a predicate written twice has already diverged, and these two had).

// One reserved comparison, as the ending decision sees it.
//
// `outstanding` is deliberately the answer for everything that is not KNOWN to be finished: an arm still
// running, an arm that succeeded and has not been reported yet, an arm nobody has submitted, and an arm whose
// batch could not be read at all. Ending a campaign on an unreadable ledger would be a decision resting on a
// read that did not happen (L2), and the cost of the other direction is only that a settle waits.
export type AttemptStanding =
  | { kind: "reported"; round: number }
  | { kind: "outstanding"; reason: string }
  | { kind: "lost"; reason: string };

// What one arm's batch is, from the platform's own record of it — never from the driver's word.
//   live       queued or running: this comparison can still complete
//   succeeded  finished with an outcome: the pair can still be reported
//   lost       the batch failed, was cancelled or superseded, or its row is not there at all (a crash
//              between the reservation and the scorecard's creation leaves exactly that)
//   unknown    the read did not happen
export type CampaignArmState = "live" | "succeeded" | "lost" | "unknown";

const ARM_SIDES = ["baseline", "candidate"] as const;

export function attemptStandingOf(
  attempt: Pick<CampaignEvaluation, "baseline" | "candidate" | "reportedRound">,
  arms: ReadonlyMap<string, CampaignArmState>,
): AttemptStanding {
  if (attempt.reportedRound !== undefined) return { kind: "reported", round: attempt.reportedRound };
  let unsubmitted = 0;
  for (const side of ARM_SIDES) {
    const arm = attempt[side];
    if (arm === undefined) {
      unsubmitted += 1;
      continue;
    }
    // An arm the map does not name was not resolved, which is `unknown` — never "fine". The map is empty for
    // a caller with no liveness evidence at all (the reservation door), and that caller must read every
    // attempt as still able to land.
    const state: CampaignArmState = arms.get(arm.scorecardId) ?? "unknown";
    if (state === "lost")
      return {
        kind: "lost",
        reason: `its ${side} batch ${arm.scorecardId} did not produce a result, so this comparison can never be reported`,
      };
  }
  return {
    kind: "outstanding",
    reason:
      unsubmitted > 0
        ? `${unsubmitted} of its two arms has not been submitted yet`
        : "both arms can still produce the pair this comparison was reserved for",
  };
}

// How much of the campaign's own budget is spent, and how much of that could still become a round.
export interface CampaignSpend {
  // Comparisons this campaign has spent: every reservation it made, plus the rounds that predate the ledger
  // (those spent a round with no attempt row to count).
  consumed: number;
  // …of which this many could still land a round. Zero is what makes an exhausted budget an ENDING rather
  // than a deadlock.
  outstanding: number;
}

// A campaign with no ledger evidence at all — `consumed` from its rounds alone, nothing outstanding. Used by
// readers that legitimately have no attempts in hand, and by the pre-ledger rows the store still holds.
export const roundsOnlySpend = (rounds: readonly CampaignRound[]): CampaignSpend => ({
  consumed: rounds.length,
  outstanding: 0,
});

export function campaignSpendOf(
  rounds: readonly CampaignRound[],
  attempts: readonly Pick<CampaignEvaluation, "baseline" | "candidate" | "reportedRound">[],
  arms: ReadonlyMap<string, CampaignArmState>,
): CampaignSpend {
  const standings = attempts.map((a) => attemptStandingOf(a, arms));
  return {
    // A round written before the ledger existed carries no `evaluationId`, so no attempt row counts it and
    // it is added here — the same arithmetic `reserveInFamily` already does on its own side.
    consumed: standings.length + rounds.filter((r) => r.verdict.evaluationId === undefined).length,
    outstanding: standings.filter((s) => s.kind === "outstanding").length,
  };
}
