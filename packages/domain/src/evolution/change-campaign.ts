import {
  BadRequestError,
  type ChangeCampaignClose,
  type ChangeCampaignRecord,
  type ChangeCriterion,
  type ChangeJudgementAnswer,
  type ChangeRound,
  type ChangeSetEntry,
  type GateRun,
  type RequirementBlocker,
  type RequirementRollup,
  type UnsettledRequirement,
} from "@everdict/contracts";

// The `change` grade's arithmetic and its refusals (docs/architecture/change-campaign-spec.md). Pure: the
// service composes these, the store persists what they allow, and nothing here reads or writes.
//
// The split this file exists to hold: the AGENT answers each criterion, and the OUTCOME is derived. A caller
// that could send both would be able to report "adopted" over an answer set that says otherwise, and the
// verdict would become a claim about a claim.

// ── EVERY DECLARED CRITERION IS ANSWERED, AND ONLY THOSE ─────────────────────────────────────────────
// Two failures, one check. A missing answer makes silence look like consent; an extra answer invents a gate
// nobody declared before the work, which is the shape a criterion assembled afterwards takes.
export function assertAnswersCoverCriteria(criteria: ChangeCriterion[], answers: ChangeJudgementAnswer[]): void {
  const declared = new Set(criteria.map((c) => c.id));
  const answered = new Set<string>();
  for (const a of answers) {
    if (!declared.has(a.criterionId))
      throw new BadRequestError(
        "BAD_REQUEST",
        { criterionId: a.criterionId },
        `criterion '${a.criterionId}' was not declared when this campaign opened — a gate invented after the work describes the outcome, it does not judge it.`,
      );
    if (answered.has(a.criterionId))
      throw new BadRequestError(
        "BAD_REQUEST",
        { criterionId: a.criterionId },
        `criterion '${a.criterionId}' is answered twice — one criterion, one answer, or the round has two verdicts and no way to choose.`,
      );
    answered.add(a.criterionId);
  }
  const missing = [...declared].filter((id) => !answered.has(id));
  if (missing.length > 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { missing },
      `unanswered criteria: ${missing.join(", ")} — an unanswered gate is not a passed one, and silence is the reading this refuses.`,
    );
}

// ── AN `observed` ANSWER POINTS AT A MEASUREMENT ─────────────────────────────────────────────────────
// The maintainer's rule: a repository gate's output is quantitative, whoever reads it. So `observed` — the
// word that distinguishes "a command ran" from "I read the code and concluded" — has to be backed by a gate
// run that reported numbers. Without this the two words are a self-description, and a round can claim the
// stronger one for free.
export function assertObservationsMeasured(answers: ChangeJudgementAnswer[], gateRuns: GateRun[]): void {
  const byId = new Map(gateRuns.map((run) => [run.id, run]));
  for (const answer of answers) {
    if (answer.how !== "observed") {
      if (answer.gateRunIds.length > 0)
        throw new BadRequestError(
          "BAD_REQUEST",
          { criterionId: answer.criterionId },
          `criterion '${answer.criterionId}' is marked asserted but cites gate runs — if a command produced this answer, it is observed.`,
        );
      continue;
    }
    if (answer.gateRunIds.length === 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { criterionId: answer.criterionId },
        `criterion '${answer.criterionId}' claims to be observed and names no gate run — an observation with no measurement is an assertion wearing the other word.`,
      );
    for (const id of answer.gateRunIds) {
      const run = byId.get(id);
      if (run === undefined)
        throw new BadRequestError(
          "BAD_REQUEST",
          { criterionId: answer.criterionId, gateRunId: id },
          `criterion '${answer.criterionId}' cites gate run '${id}', which this round does not carry.`,
        );
    }
  }
}

// ── A COMMIT BELONGS TO EXACTLY ONE ROUND ────────────────────────────────────────────────────────────
// "Which attempt changed this" must have one answer. Without this, the second claim silently wins and a
// round's change set slowly becomes a description of the branch rather than of the attempt.
// `rounds` is the WHOLE CHAIN's rounds, not this campaign's: with one open campaign per issue and successors
// that name what they continue, the walk is the unit "which attempt changed this" is asked over. Scoped to a
// single campaign, a successor could re-claim its predecessor's commits and the lineage would show them twice.
export function assertCommitsUnclaimed(rounds: ChangeRound[], changes: ChangeSetEntry[]): void {
  const claimed = new Map<string, number>();
  for (const round of rounds)
    for (const entry of round.changes)
      for (const commit of entry.commits) claimed.set(`${entry.repository}@${commit.sha}`, round.seq);
  for (const entry of changes)
    for (const commit of entry.commits) {
      const key = `${entry.repository}@${commit.sha}`;
      const seq = claimed.get(key);
      if (seq !== undefined)
        throw new BadRequestError(
          "BAD_REQUEST",
          { repository: entry.repository, sha: commit.sha, roundSeq: seq },
          `commit ${commit.sha} in ${entry.repository} is already claimed by round ${seq} — a commit in two rounds makes "what did this attempt change" unanswerable.`,
        );
      claimed.set(key, -1);
    }
}

// ── THE OUTCOME IS DERIVED, NEVER DECLARED ───────────────────────────────────────────────────────────
// `not_run` is not `met`: a gate the work could not reach is an escalation, not a silence (protocol L2). So a
// round is adopted only when every declared criterion came back met, and the answers — not the caller — say so.
export function deriveRoundOutcome(answers: ChangeJudgementAnswer[]): ChangeRound["outcome"] {
  return answers.every((a) => a.answer === "met") ? "adopted" : "rejected";
}

// ── A CAMPAIGN DECLARES WHAT IT IS FOR ───────────────────────────────────────────────────────────────
// At least one criterion must answer a REQUEST. Without this a campaign can be opened entirely out of
// quality gates — every one of them green, the round adopted, and the request it serves never mentioned. The
// count would then read 0 of 0 forever, which is the shape that made "how much of this is done" unanswerable
// in the first place. When the request is atomic the criterion names the campaign's own issue; that is one
// word and it is the point, because "this campaign answers this request" stops being an inference.
export function assertDeclaresARequirement(criteria: ChangeCriterion[]): void {
  if (criteria.some((c) => c.judges.kind === "requirement")) return;
  throw new BadRequestError(
    "BAD_REQUEST",
    { criteria: criteria.length },
    'no criterion names a requirement — a campaign made only of quality gates can pass without anyone saying what was asked for. Point at least one criterion at the issue it settles (`judges: { kind: "requirement", issueId }`); when the request is atomic, that is the campaign\'s own issue.',
  );
}

// ── THE REQUIREMENT AXIS (maintainer, 2026-09-17) ────────────────────────────────────────────────────
//
// "Five things were asked for, two shipped, three did not — and here is why each one did not" is the account
// a request owes its reader, and until criteria said what they judge, it could not be computed from the
// record. It was prose in a `detail` field, so nothing could count it, compare it across rounds, or notice
// that a campaign closed with requests still owed.
//
// Derived, never stored: the same reason the round's outcome is derived. A stored count would be a second
// opinion about the answers, and two numbers about one thing means someone has to decide which lies.
//
// A requirement may carry SEVERAL criteria (a thing asked for that took two gates to settle). It is settled
// only when every one of them came back met — the same arithmetic as the round, one level down. And every
// blocker is listed rather than folded into a first-wins summary: two criteria unmet for two different
// reasons is two different next actions, and picking one of them to show is how the other disappears.
// The shapes live in `@everdict/contracts` because they cross the wire; this file owns the ARITHMETIC that
// produces them. One declaration, one owner — a rollup type spelled here as well would grow its next field
// in one of the two places (protocol L3: a predicate written twice has already diverged).

export function summariseRequirements(
  criteria: ChangeCriterion[],
  answers: ChangeJudgementAnswer[],
): RequirementRollup {
  const answerById = new Map(answers.map((a) => [a.criterionId, a]));
  const byIssue = new Map<string, { criterionIds: string[]; blockers: RequirementBlocker[] }>();

  for (const criterion of criteria) {
    if (criterion.judges.kind !== "requirement") continue;
    const issueId = criterion.judges.issueId;
    const bucket = byIssue.get(issueId) ?? { criterionIds: [], blockers: [] };
    bucket.criterionIds.push(criterion.id);

    const answer = answerById.get(criterion.id);
    // An UNANSWERED criterion cannot settle a requirement. `assertAnswersCoverCriteria` refuses that shape at
    // the write, so this arm is only reachable for a rollup computed over a partial answer set — and even
    // then the honest reading is "not settled", never "settled by silence".
    if (answer === undefined)
      bucket.blockers.push({ criterionId: criterion.id, answer: "not_run", reason: "needs_information" });
    else if (answer.answer !== "met")
      bucket.blockers.push({ criterionId: criterion.id, answer: answer.answer, reason: answer.reason });

    byIssue.set(issueId, bucket);
  }

  const unsettled: UnsettledRequirement[] = [];
  let settled = 0;
  for (const [issueId, bucket] of byIssue) {
    if (bucket.blockers.length === 0) settled += 1;
    else unsettled.push({ issueId, criterionIds: bucket.criterionIds, blockers: bucket.blockers });
  }

  return {
    total: byIssue.size,
    settled,
    unsettled,
    unclassifiedCriteria: criteria.filter((c) => c.judges.kind === "unclassified").length,
  };
}

// A one-line reading for humans and for the issue's journal: what the round answered, in the vocabulary the
// spec's verdict table uses.
export function summariseAnswers(answers: ChangeJudgementAnswer[]): {
  met: number;
  notMet: number;
  notRun: number;
  observed: number;
  asserted: number;
} {
  return {
    met: answers.filter((a) => a.answer === "met").length,
    notMet: answers.filter((a) => a.answer === "not_met").length,
    notRun: answers.filter((a) => a.answer === "not_run").length,
    observed: answers.filter((a) => a.how === "observed").length,
    asserted: answers.filter((a) => a.how === "asserted").length,
  };
}

// ── CLOSING ──────────────────────────────────────────────────────────────────────────────────────────
// An adopted close must point at a round that was actually adopted — the derived outcome above, not the
// closer's opinion of it. And no campaign closes in silence: what it taught, or a stated refusal. Accepted is
// not learned, and a campaign that closes with neither has stopped rather than finished.
export function assertClosable(campaign: ChangeCampaignRecord, close: Omit<ChangeCampaignClose, "at" | "by">): void {
  if (campaign.state !== "open")
    throw new BadRequestError(
      "BAD_REQUEST",
      { state: campaign.state },
      `campaign is already ${campaign.state} — a second close would rewrite a history, not record one.`,
    );
  if (close.knowledge.length === 0 && (close.knowledgeDeclined ?? "").trim() === "")
    throw new BadRequestError(
      "BAD_REQUEST",
      {},
      "a campaign may not close in silence: name the knowledge entries it produced, or decline with `knowledgeDeclined` — a refusal someone can read is a decision, silence is not.",
    );
  if (close.state === "partially_adopted") {
    if (close.landed.length === 0 || close.remaining.length === 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { landed: close.landed.length, remaining: close.remaining.length },
        "a partial adoption names BOTH what landed and what is still owed — one of them empty is an adoption or an abandonment wearing the middle word.",
      );
    return;
  }
  if (close.state === "abandoned") return;
  if (close.landed.length > 0 || close.remaining.length > 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      {},
      "landed/remaining belong to a partial adoption — a full one leaves nothing owed, and saying otherwise is a second ending.",
    );
  const round = campaign.rounds.find((r) => r.seq === close.roundSeq);
  if (round === undefined)
    throw new BadRequestError(
      "BAD_REQUEST",
      { roundSeq: close.roundSeq },
      "an adopted close names the round that carried it, and that round must exist.",
    );
  if (round.outcome !== "adopted")
    throw new BadRequestError(
      "BAD_REQUEST",
      { roundSeq: round.seq, outcome: round.outcome },
      `round ${round.seq} was ${round.outcome} — a campaign cannot adopt a round whose own criteria did not all come back met.`,
    );
}
