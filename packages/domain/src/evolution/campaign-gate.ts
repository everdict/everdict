import type { CampaignAdoptionProof, CampaignFrame, CampaignRound, CandidateSource } from "@everdict/contracts";
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
// whereas no_improvement, budget_exhausted and exam_inert are the campaign's own endings.

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
      // …and where those bytes were built from — the round's platform-copied origin coordinates
      // (docs/architecture/code-evolution-loop.md, D4). Carried, never weighed: the gate decides on the
      // held-out counts and the identity axes, and this rides to the close and the proof so a merge can name
      // the pull request it is about.
      candidateSource?: CandidateSource;
      // Carried on EVERY arm, adoption included: a candidate adopted over an exam whose other scenarios
      // nothing has ever passed is a narrower result than it reads as, and the reader should see that where
      // the decision is, not in a separate query.
      neverSolved?: string[];
    }
  | { kind: "continue"; roundsLeft: number; consecutiveRejected: number; neverSolved?: string[] }
  | {
      kind: "halt";
      reason: "no_improvement" | "budget_exhausted" | "identity_unverified" | "exam_inert";
      detail: string;
      neverSolved?: string[];
    };

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
  // ── THE ISSUE'S OWN CASES HAVE TO FLIP (docs/architecture/evolution-routing-spec.md §3) ───────────
  //
  // A frame with `targets` asks a sharper question than "did anything held-out improve": did THESE cases, the
  // ones the issue named, now pass — and did nothing held-out regress. The aggregate `improvements >= 1` is
  // replaced by the targets, because a narrow, correct fix improves what it was asked to and nothing else, and
  // that IS the adoption the program describes. Read from the POLICY (the frame), never from the data: a round
  // that carries no `targets` block under a frame that declares them is a round that could not answer, and a
  // question the round could not answer is refused rather than waved through (the minimumCoverage lesson).
  if (frame.targets.length > 0) {
    const t = v.targets;
    if (t === undefined) return false;
    const flipped = new Set(t.flipped);
    if (!frame.targets.every((id) => flipped.has(id))) return false;
    return held.regressions === 0;
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
    ...(answer.candidateSource !== undefined ? { candidateSource: answer.candidateSource } : {}),
    issueId: campaign.issueId,
    // …and the authority this campaign decided under. Carried so a registry write is gated against the team
    // frozen at open rather than whatever the entity's team happens to be when somebody spends it
    // (arch-review 76 P1-security).
    gateDigest: contentDigest(answer),
  };
}

// ── THE FRAME'S ENDINGS ARE FACTS ABOUT THE TRACE, NOT QUESTIONS THE DRIVER HAS TO ASK ──────────────
//
// The frame pre-registers two ways a campaign ends without adopting — the budget is spent, or K rounds in a
// row were rejected — and every round is judged at `fdrAlpha / heldOutFamilySize` on the promise that at
// most `family` rounds ever consult the held-out rows. Both endings used to be ANSWERED here and enforced by
// nobody: this function looked at the LATEST round for a win before it looked at either ending, and nothing
// refused an append past them. So a driver that never asked `decision`, or ignored a halt, could keep
// logging until a round happened to win, and the gate adopted it — optional stopping, at a level the
// pre-registered family never covered. The skill's "the gate stops the walk, you do not have to count" was
// a sentence about a driver.
//
// This is the one owner of "where did this campaign end". The service refuses an append past it (through
// `campaignRoundRefusal`, race-safe because the store CASes on the round count), and the gate reads it
// BEFORE it reads a win, so a round logged past the ending is not evidence whatever it scored.
export interface CampaignStop {
  reason: "no_improvement" | "budget_exhausted";
  atRound: number; // 1-based position of the round at which the frame's rule fired
}

// ── WHICH ENDING IT WAS: THE HYPOTHESES, OR THE INSTRUMENT ──────────────────────────────────────────
//
// `campaignStoppedAt` decides WHEN a campaign ends and this decides what to CALL that ending. The split is
// deliberate and it is what makes the diagnosis safe to add: a campaign is never ended by this function, so
// a wrong answer here costs a word in a record and can never cost a round.
//
// A frozen frame that has never once been solved, across every round logged against it, is not a well of
// dry hypotheses — it is an exam that does not respond, and the next round meets the same one. The mirror
// case is an exam every arm passes completely: no headroom, so no candidate can ever show an improvement.
// Both are `exam_inert`; the detail says which.
//
// SILENCE IS NOT INERTNESS. A round logged before `verdict.response` existed cannot say what it scored in
// absolute terms — the level is not recoverable from deltas — so ONE such round withholds the diagnosis for
// the whole campaign. That is L2's third value placed on the fail-safe side: an unproven accusation about
// somebody's exam is worse than an imprecise ending, and the ending is already correct.
// ── WHICH SCENARIOS NOTHING HAS EVER PASSED ─────────────────────────────────────────────────────────
//
// `examInertness` is all-or-nothing and the failure it was written for was a SUBSET: a wave whose best round
// read `31202:5/5 34033:4/5 38537:1/5` over eleven cases at 0/5 has a responsive exam by every whole-campaign
// predicate, and eleven of its fourteen scenarios had never been passed by anything. Several of those were
// structurally unwinnable — a grader that could not read their answer range, and one whose published answer
// key was permuted — and that is the loudest thing the trace contains.
//
// It is NOT an ending. An exam that responds on three cases is not inert and the campaign may legitimately
// keep improving those three; this is the sentence that points at the dataset, carried on `continue` as well
// as on the halt, because the driver asks `decision` every round and round 2 is when it was worth knowing.
//
// Silence withholds it, like every other reading of `response`: one round that cannot say what it solved
// makes "never solved" unprovable for the whole walk.
export function neverSolvedAcross(frame: CampaignFrame, rounds: readonly CampaignRound[]): string[] | undefined {
  if (rounds.length === 0) return undefined;
  const solved = new Set<string>();
  for (const r of rounds) {
    const level = r.verdict.response;
    if (level === undefined) return undefined;
    for (const id of level.solved) solved.add(id);
  }
  const never = frame.scenarios.map((sc) => sc.id).filter((id) => !solved.has(id));
  return never.length > 0 ? never : undefined;
}

export type ExamInertness = "never_solved" | "no_headroom" | "never_measured";

export function examInertness(rounds: readonly CampaignRound[]): ExamInertness | undefined {
  if (rounds.length === 0) return undefined;
  const spoke = rounds.map((r) => ({ level: r.verdict.response, unmeasured: r.verdict.unmeasured }));
  // A round that can say neither what it scored nor that it could not be scored withholds the diagnosis for
  // the whole campaign — one is enough (see the block above).
  if (spoke.some((it) => it.level === undefined && it.unmeasured === undefined)) return undefined;
  // The grader never answered, in every round. Checked first: such a round has no level to read, so asking
  // the level questions of a mixed trace would compare a population against a smaller one.
  if (spoke.every((it) => it.unmeasured !== undefined && it.unmeasured.cases > 0)) return "never_measured";
  const levels = spoke.map((it) => it.level);
  // A MIX of measured-and-dead with could-not-measure is not a conclusion. The two have different repairs —
  // one is a dataset whose cases nobody can pass, the other a grader that cannot read them — and a campaign
  // that saw both has not told us which dominates.
  if (levels.some((it) => it === undefined)) return undefined;
  const said = levels.filter((it): it is NonNullable<typeof it> => it !== undefined);
  if (said.every((it) => it.solved.length === 0)) return "never_solved";
  if (said.every((it) => it.failed.length === 0)) return "no_headroom";
  return undefined;
}

// The ending's own words, once `examInertness` has said the instrument is what ended it.
export function inertDetail(kind: ExamInertness, rounds: number): string {
  switch (kind) {
    case "never_solved":
      return `no scenario of this frozen exam has ever been passed by either arm, across all ${rounds} logged round(s) — the exam never responded, so no candidate could have shown an improvement and none can`;
    case "no_headroom":
      return `every scenario passes on both arms in all ${rounds} logged round(s) — the exam has no headroom left to measure an improvement in`;
    case "never_measured":
      return `every one of the ${rounds} logged round(s) had scenarios the graders could not be measured on at all — the campaign ended on a grader that cannot answer, not on hypotheses that were tried and lost`;
  }
}

export function campaignStoppedAt(frame: CampaignFrame, rounds: readonly CampaignRound[]): CampaignStop | undefined {
  let consecutiveRejected = 0;
  for (let i = 0; i < rounds.length; i += 1) {
    const r = rounds[i];
    if (r === undefined) continue;
    const won = winning(r, frame);
    consecutiveRejected = won ? 0 : consecutiveRejected + 1;
    // The streak halt outranks the budget halt: "K straight rejections" names what is wrong (the hypothesis
    // well is dry), where "the budget ran out" only names when it stopped mattering.
    if (consecutiveRejected >= frame.stopAfterRejectedRounds) return { reason: "no_improvement", atRound: i + 1 };
    // The last budgeted round ends the campaign unless it is the one being adopted.
    if (i + 1 >= frame.budget.maxRounds && !won) return { reason: "budget_exhausted", atRound: i + 1 };
  }
  return undefined;
}

// Why one more round may NOT be appended — the write-side half of the same rule, `undefined` while the walk
// is live. A spent budget refuses even after a WIN on the last budgeted round: adoption is that campaign's
// exit, and another round would be a test the pre-registered family does not cover.
export function campaignRoundRefusal(
  frame: CampaignFrame,
  rounds: readonly CampaignRound[],
): (CampaignStop & { detail: string }) | undefined {
  const stopped = campaignStoppedAt(frame, rounds);
  if (stopped !== undefined)
    return {
      ...stopped,
      detail:
        stopped.reason === "no_improvement"
          ? `${frame.stopAfterRejectedRounds} consecutive rounds were rejected by round ${stopped.atRound} — the campaign ended by its own rule; ask the gate and settle it`
          : `all ${frame.budget.maxRounds} budgeted rounds are logged and the last is not adoptable — the campaign ended by its own rule; ask the gate and settle it`,
    };
  if (rounds.length >= frame.budget.maxRounds)
    return {
      reason: "budget_exhausted",
      atRound: rounds.length,
      detail: `all ${frame.budget.maxRounds} budgeted rounds are logged — a round past the budget would be judged at a level the pre-registered held-out family does not cover; ask the gate and settle`,
    };
  return undefined;
}

export function campaignAdoption(frame: CampaignFrame, rounds: readonly CampaignRound[]): CampaignGateAnswer {
  // Attached ONCE, to whatever the decision turns out to be, rather than at each of the nine return sites —
  // a field spelled nine times is eight chances for the next ending to forget it (rule `protocol`, the
  // one-lane-only law counted at return statements instead of call sites).
  const answer = decideAdoption(frame, rounds);
  const neverSolved = neverSolvedAcross(frame, rounds);
  if (neverSolved === undefined) return answer;
  // …and if this ending has scenarios nothing ever passed AND the frame never named a positive control, say
  // so HERE, which is the moment somebody reads why the campaign stopped. The control is opt-in and the
  // campaigns that most need it are the ones that will not set it; a frame every scenario has been solved on
  // has nothing to answer for, and a warning that fires everywhere is read nowhere.
  if (answer.kind === "halt" && frame.examProvenBy === undefined)
    return {
      ...answer,
      neverSolved,
      detail: `${answer.detail}. ${neverSolved.length} of the frame's ${frame.scenarios.length} scenario(s) were never passed by either arm in any round (${neverSolved.slice(0, 8).join(", ")}${neverSolved.length > 8 ? ", …" : ""}), and this frame declared no positive control (examProvenBy), so nothing has established that its exam can be scored at all`,
    };
  return { ...answer, neverSolved };
}

function decideAdoption(frame: CampaignFrame, rounds: readonly CampaignRound[]): CampaignGateAnswer {
  // The ending first: a round logged after the frame's own rule fired is not evidence, whatever it scored.
  const ended = campaignStoppedAt(frame, rounds);
  if (ended !== undefined) {
    const after = rounds.length - ended.atRound;
    const tail = after > 0 ? ` — the ${after} round(s) logged after it are not adoption evidence` : "";
    // WHICH ending it was. The rule that fired is settled above and is not revisited here; this only asks
    // whether the thing that ran out was the hypotheses or the exam. It reads every logged round, including
    // any past the ending: a round logged late is not adoption evidence, and it is still a measurement of
    // whether this frozen exam responds at all.
    const inert = examInertness(rounds);
    if (inert !== undefined) return { kind: "halt", reason: "exam_inert", detail: inertDetail(inert, rounds.length) };
    return ended.reason === "no_improvement"
      ? {
          kind: "halt",
          reason: "no_improvement",
          detail: `${frame.stopAfterRejectedRounds} consecutive rounds were rejected by round ${ended.atRound} (frame stops after ${frame.stopAfterRejectedRounds})${tail}`,
        }
      : {
          kind: "halt",
          reason: "budget_exhausted",
          detail: `${Math.min(ended.atRound, frame.budget.maxRounds)} of ${frame.budget.maxRounds} budgeted rounds are spent and the latest budgeted candidate is not adoptable${tail}`,
        };
  }
  // Not stopped and still over budget: only a trace whose LAST budgeted round won can get here, followed by
  // rounds the write should have refused (rows from before the refusal existed). Those are not evidence
  // either — the level they were judged at assumed they would never be asked.
  if (rounds.length > frame.budget.maxRounds)
    return {
      kind: "halt",
      reason: "budget_exhausted",
      detail: `${rounds.length} rounds exceed the budget of ${frame.budget.maxRounds} — rounds past the budget were judged at a level the pre-registered held-out family does not cover, and are not adoption evidence`,
    };
  const latest = rounds.at(-1);
  // Only the LATEST round's candidate is on the table: adoption is of the current variant, and a stale win
  // followed by a worse attempt is a loop that returns to the winner explicitly, never a gate doing
  // archaeology over the trace.
  if (latest !== undefined && winning(latest, frame)) {
    const unverified = latest.verdict.unverifiedAxes;
    if (unverified.length > 0 && !frame.allowUnverifiedIdentity) {
      // The remedy is a frame field, so the halt NAMES it. A loop over INGESTED scorecards never has a
      // manifest, so every axis reads unverified on every round and its first win lands here — and the only
      // waiver the agent-evolve skill used to teach was the other one.
      return {
        kind: "halt",
        reason: "identity_unverified",
        detail: `the winning round's comparison could not verify ${unverified.join(", ")} — an optimization verdict over an unverifiable world is refused unless the frame recorded allowUnverifiedIdentity at open. Run a round through a lane that seals a manifest, or — for a loop over ingested scorecards, which seal none and read unverified on every axis — open the campaign with that waiver declared`,
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
      ...(latest.verdict.candidateSource !== undefined ? { candidateSource: latest.verdict.candidateSource } : {}),
    };
  }

  // Live: the latest is not a win (or the trace is empty), and neither ending has fired.
  let consecutiveRejected = 0;
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    const r = rounds[i];
    if (r === undefined || winning(r, frame)) break;
    consecutiveRejected += 1;
  }
  return { kind: "continue", roundsLeft: frame.budget.maxRounds - rounds.length, consecutiveRejected };
}
