import type { CampaignAdoptionProof, CampaignFrame, CampaignRound } from "@everdict/contracts";
import { contentDigest } from "../provenance/content-digest.js";

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
  // ── …AND ENOUGH OF THE ROUND WAS ACTUALLY LOOKED AT (arch-review 72 P2, fixed 75) ─────────────────
  //
  // Read from the POLICY, not from the data. The first version put this inside `if (obs !== undefined)`,
  // so a frame demanding `minimumCoverage: 0.5` was satisfied by a round carrying no observations block at
  // all — the exact "an absence is not a clean bill of health" defect the same commit was written to close,
  // reproduced by its own fix one branch up. Zero divergences over zero assessments is silence; NO BLOCK is
  // a louder silence, and a campaign that declared it needs coverage may not be answered with either.
  //
  // `assessed`/`eligible` are optional at rest so rows written before they existed still decode
  // (arch-review 75); absent means UNKNOWN COVERAGE, which is refused here rather than backfilled — a
  // manufactured number would be exactly the evidence the policy exists to require.
  const need = frame.observationPolicy.minimumCoverage;
  if (need !== undefined) {
    if (obs?.assessed === undefined || obs.eligible === undefined) return false;
    if (obs.eligible === 0 || obs.assessed / obs.eligible < need) return false;
  }
  return held.improvements >= 1 && held.regressions === 0;
}

// ── THE ANSWER, IN A FORM AN EFFECT CAN BE HELD TO (arch-review 71 P0-evolution) ────────────────────
//
// `campaignAdoption` answers whether to adopt; this turns that answer into the PROOF a registry write has to
// present. Minted here, from the round that proved it and the frame it was proved under — never re-derived
// at the effect, which is where a substitution would enter (L3).
//
// `gateDigest` covers the answer itself, so a proof cannot be edited into authorizing a different version.
// Returns undefined for any answer that is not an adoption: there is nothing to authorize.
export function adoptionProofOf(
  answer: CampaignGateAnswer,
  campaign: { id: string; frameDigest: string; issueId: string; frame: CampaignFrame },
  rounds: readonly CampaignRound[],
): CampaignAdoptionProof | undefined {
  if (answer.kind !== "adopt") return undefined;
  const latest = rounds.at(-1);
  if (latest === undefined) return undefined;
  // ── AND HOW STRONG THIS PROOF IS (arch-review 72 P1-medium) ──────────────────────────────────────
  //
  // A campaign that could not name the bytes it measured authorizes only a LABEL, and that is a weaker
  // adoption an operator has to be able to see. Recorded here; DECIDED by the gate — this function mints,
  // it does not adjudicate (arch-review 73: the first version refused here, and a refusal at the minter
  // left `campaignAdoption` still answering `adopt`, which is a close with nothing to authorize).
  const exact = answer.candidateSpecDigest !== undefined;
  return {
    campaignId: campaign.id,
    frameDigest: campaign.frameDigest,
    roundSeq: latest.seq,
    candidate: {
      identity: exact ? ("exact" as const) : ("label_only" as const),
      type: campaign.frame.subject.type,
      id: campaign.frame.subject.id,
      version: answer.version,
      ...(answer.candidateSpecDigest !== undefined ? { specDigest: answer.candidateSpecDigest } : {}),
    },
    provingScorecardId: answer.provingScorecardId,
    issueId: campaign.issueId,
    gateDigest: contentDigest(answer),
  };
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
    // ── …AND THE ADOPTION HAS TO BE ABLE TO NAME ITS BYTES (arch-review 73 P0) ──────────────────────
    //
    // Same shape as the axis check above, and refused the same way: a round whose scorecard sealed no
    // manifest cannot say WHICH spec it measured, so an adoption over it authorizes a version LABEL and
    // nothing checkable. The frame may waive that at open — and until it does, this is `identity_unverified`
    // rather than an ending, because the remedy is another round through a lane that seals one.
    //
    // The decision lives HERE, in the function that answers, because the waiver is a frozen frame
    // declaration and rule `suite` says a declaration is not constitutional until the deciding function
    // consumes it. Refusing at the proof minter instead left this returning `adopt` over an unauthorizable
    // candidate — arch-review 71's abolished state, reopened by the change that was tightening the evidence.
    if (latest.verdict.candidateSpecDigest === undefined && !frame.allowLabelOnlyAdoption) {
      return {
        kind: "halt",
        reason: "identity_unverified",
        detail:
          "the winning round's candidate scorecard sealed no spec digest, so the adoption could name only the version label — a candidate substituted between the evaluation and the registration would be undetectable. Run a round whose batch seals a manifest, or record allowLabelOnlyAdoption on the frame at open",
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
