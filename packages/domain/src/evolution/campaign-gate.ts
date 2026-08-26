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
  | {
      kind: "adopt";
      version: string;
      provingScorecardId: string;
      waivedAxes: string[];
      // WHICH BYTES the adoption is about (arch-review 71 P0-evolution). The version is a label; two specs
      // can wear one. An effect that consumes this answer can check what it is about to register against
      // what was actually proved — and `undefined` says plainly that this round could not name them, which
      // is a weaker adoption an operator can see rather than one that reads the same as a strong one.
      candidateSpecDigest?: string;
    }
  | { kind: "continue"; roundsLeft: number; consecutiveRejected: number }
  | { kind: "halt"; reason: "no_improvement" | "budget_exhausted" | "identity_unverified"; detail: string };

// A round is a WIN only when its comparison actually held: a non-comparable pair produced no significance
// signal, and counts riding on it are not evidence.
// ── …AND THE WIN IS DECIDED ON THE HELD-OUT POPULATION (arch-review 71 P1-high) ────────────────────
//
// This read the whole round's counts, so a candidate that improved only where the loop had been pushing —
// and nowhere it was not allowed to look — adopted. The training set is the loop's own feedback; it is
// evidence about the search, not about the capability.
//
// A round that cannot separate the two populations is NOT adoption evidence. Older rows have no `heldOut`
// block, and treating their whole-round counts as held-out results would be reading a number that answers a
// different question — so they lose, which is the fail-closed direction.
function winning(round: CampaignRound, frame: CampaignFrame): boolean {
  const v = round.verdict;
  if (!v.comparable) return false;
  const held = v.heldOut;
  if (held === undefined) return false;
  // ── …AND THE CANDIDATE'S OWN ACCOUNT HAS TO HOLD UP (arch-review 71 P1-evolution) ─────────────────
  //
  // `divergent` is a judge, shown the platform's own observation account, saying the candidate's story does
  // not match what the platform watched it do. That is the strongest negative evidence this system can
  // produce, and it used to live in rendered prose where no decision could reach it — so a candidate could
  // improve its scores while its own judges said it was not telling the truth about how, and adopt.
  //
  // Refused by DEFAULT. A campaign that wants to optimize through the noise says so in its frozen frame.
  const obs = v.observations;
  if (obs !== undefined) {
    if (obs.divergent > 0 && !frame.observationPolicy.allowDivergent) return false;
    const maxUnclear = frame.observationPolicy.maxUnclear;
    if (maxUnclear !== undefined && obs.unclear > maxUnclear) return false;
  }
  return held.improvements >= 1 && held.regressions === 0;
}

export function campaignAdoption(frame: CampaignFrame, rounds: readonly CampaignRound[]): CampaignGateAnswer {
  const latest = rounds.at(-1);
  // Only the LATEST round's candidate is on the table: adoption is of the current variant, and a stale win
  // followed by a worse attempt is a loop that returns to the winner explicitly, never a gate doing
  // archaeology over the trace.
  if (latest !== undefined && winning(latest, frame)) {
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
      // …minted from the round that PROVED it, never re-derived at adoption time (L3).
      ...(latest.verdict.candidateSpecDigest !== undefined
        ? { candidateSpecDigest: latest.verdict.candidateSpecDigest }
        : {}),
    };
  }

  let consecutiveRejected = 0;
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    const r = rounds[i];
    if (r === undefined || winning(r, frame)) break;
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
