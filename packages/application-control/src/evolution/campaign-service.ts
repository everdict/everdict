import type { CampaignFrame, CampaignRound, DomainFact, EvolutionCampaignRecord } from "@everdict/contracts";
import {
  type AdoptionOperation,
  BadRequestError,
  ConflictError,
  NotFoundError,
  type Score,
  isMeasured,
} from "@everdict/contracts";
import { campaignFrameDefects } from "@everdict/contracts";
import type { ExperimentIdentity, TrialDiff } from "@everdict/domain";
import { type CampaignGateAnswer, adoptionProofOf, campaignAdoption, contentDigest } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { AdoptionOperationStore, EvolutionCampaignStore } from "../ports/evolution-campaign-store.js";

// ── THE CAMPAIGN SERVICE (docs/architecture/evolution-lineage.md, Track D) ───────────────────────────
//
// The agent-evolve loop's settlement owner. The frame is frozen at open (digest recorded); every round's
// VERDICT is derived here from the one production diff predicate — trials significance + experiment
// identity — never accepted from the caller, which would let the loop write its own report card (L3); and
// the close is the pure gate's answer made durable. The ISSUE beside it stays the journal and intent hub.

// What the service reads off the production diff. Structural, so the real ScorecardService facade
// satisfies it without this package depending on its whole surface.
export interface CampaignComparison {
  comparability: "full" | "partial" | "none";
  trials?: TrialDiff;
  experiment?: ExperimentIdentity;
}

// The identity of one compared side — the RECORD's own account of what it evaluated, which is what the
// round's caller-declared coordinates are verified against (the caller may not name the exam or the
// graduate; the scorecard already did).
export interface CampaignComparisonSide {
  record: {
    harness: { id: string; version: string };
    orchestration?: { judges?: Array<{ id: string }> };
    // ── WHAT THE JUDGES SAID ABOUT THIS SIDE'S ACCOUNT OF ITSELF (arch-review 71 P1-evolution) ──────
    //
    // The per-case scores, for the one thing the round verdict cannot derive from a trials comparison: a
    // judge that was shown the platform's observation account and answered whether the trace agrees with it.
    // Without this the field existed on the score, the policy existed on the frame, and nothing joined them
    // — which is the shape this whole review is about, one layer up.
    // `record.scorecard.results` is the per-case `CaseResult[]` the detail read carries — the same rows the
    // analyst sees, so nothing new is fetched and nothing is re-derived from rendering.
    scorecard?: { results: ReadonlyArray<{ scores: Score[] }> };
    // The digest of the spec that batch actually ran, sealed at submit. This is the join every later
    // adoption proof rests on: a version label cannot tell an evaluated C1 from a saved C2 (arch-review 71
    // P0-evolution).
    manifest?: { harness?: { specDigest?: string } };
  };
}

// Counted over the CANDIDATE side: the question adoption asks is whether the thing being adopted tells the
// truth about what it did. `undefined` when the side carries no scores at all — a round that cannot say is
// not evidence either way, and the gate treats an absent block as "nothing to weigh" rather than as clean.
function observationsOf(
  side: CampaignComparisonSide,
): { divergent: number; unclear: number; assessed: number; eligible: number } | undefined {
  const results = side.record.scorecard?.results;
  if (results === undefined) return undefined;
  let divergent = 0;
  let unclear = 0;
  // THROUGH THE MEASURED GATE, like every other consumer of `.scores` (rule `suite`). An `unmeasured` row
  // is a grader failure, not a judgment about the agent — it carries no assessment, and counting one would
  // be reading a verdict out of an absence.
  // COVERAGE, not just failures (arch-review 72 P2). "Every judge said consistent" and "no judge recorded
  // anything" both produced zeroes, and a gate could not tell them apart.
  let assessed = 0;
  let eligible = 0;
  for (const r of results)
    for (const sc of r.scores.filter(isMeasured)) {
      eligible += 1;
      if (sc.observationAssessment !== undefined) assessed += 1;
      if (sc.observationAssessment?.status === "divergent") divergent += 1;
      if (sc.observationAssessment?.status === "unclear") unclear += 1;
    }
  return { divergent, unclear, assessed, eligible };
}

export interface CampaignSnapshot {
  diff: CampaignComparison;
  baseline: CampaignComparisonSide;
  candidate: CampaignComparisonSide;
}

// The team-visibility ceiling the caller resolved for its principal — REQUIRED, because the round's diff
// reads two scorecards and must refuse the ones a direct read would refuse (no side channel around the
// team axis). `{}` states full visibility (an admin), never "forgot".
export interface TeamAccess {
  visibleTeams?: string[];
}

export interface CampaignServiceDeps {
  store: EvolutionCampaignStore;
  // The intent hub the campaign journals into — an unreadable issue refuses the open (its `get` throws).
  // …and the TEAM it belongs to. A campaign journals into this issue, so they cannot be owned by different
  // teams without one of them being a lie — the campaign's authority is frozen from here at open
  // (arch-review 76 P1-security).
  issues: { get(tenant: string, ref: string): Promise<{ id: string; teamId?: string }> };
  // THE diff predicate (the ScorecardService facade's diffSnapshot) — policy-resolved transitions, trial
  // statistics, experiment identity, AND the two sides' records, so the round's declared coordinates are
  // verified against what actually ran. One owner; this service only summarizes its answer.
  diffs: {
    diffSnapshot(
      tenant: string,
      baselineId: string,
      candidateId: string,
      opts?: { minDelta?: number; fdrAlpha?: number; visibleTeams?: string[] },
    ): Promise<CampaignSnapshot>;
  };
  // ── WHERE THE AUTHORIZATION CAN BE READ (arch-review 73) ────────────────────────────────────────
  //
  // arch-review 71 wrote the durable operation and described `decided` as "visible, addressable,
  // re-drivable — where a campaign that merely said `adopted` was none of those". Nothing in `apps/api`
  // called `forCampaign`, so none of those three words was true: a settled campaign left an authorization
  // no caller could see, let alone present. That is this repo's own comment-is-a-claim law — the half that
  // was implemented is the WRITE, and the half that was written down is the recovery.
  //
  // REQUIRED, not optional: an operation nobody can read is the same defect as one nobody can spend, and
  // an optional dep is the shape that hides it (rule `protocol`, the optional-dependency law).
  operations: AdoptionOperationStore;
  newId?: () => string;
  now?: () => string;
}

export interface NewCampaignInput {
  issueId: string;
  frame: CampaignFrame;
  // ── THE TEAM THE TRANSPORT AUTHORIZED AGAINST (arch-review 115) ─────────────────────────────────
  //
  // The route reads the issue to gate `scorecards:run` on its team, and `open` below reads the SAME issue
  // again to stamp the campaign's own team. Between the two, `POST /issues/:id/team` can move it — so a
  // caller authorized for Team A files a Team B campaign, and every later gate on that campaign answers for
  // a team this caller was never cleared for.
  //
  // Same law as the registry's `expectedOwnerTeamId`: an authorization and the effect it authorizes read the
  // mutable fact ONCE. Absent means the caller stated no expectation (a headless or seeded open); present
  // and different is a refusal, not a quiet re-file.
  expectedIssueTeamId?: string;
}

export interface NewRoundInput {
  hypothesis: string;
  candidateVersion: string;
  baselineScorecardId: string;
  candidateScorecardId: string;
}

// How far a `continues` walk will follow caller-authored links before refusing. A chain this long is not a
// research programme, it is a loop or a mistake, and either way the answer is the same refusal.
const MAX_CHAIN_LINKS = 64;

// The held-out POPULATION, as a comparable key. Deduplicated and sorted because the question is "are these
// the same rows", not "were they written in the same order" — and the frame's own creation rule already
// refuses duplicate ids, so the dedupe only matters for frames written before it did.
//
// `\u0000` separates because a scenario id may contain anything a 300-character string can, a space
// included: joining on one would let {"a b"} and {"a","b"} produce the same key, and the chain check would
// then accept a different exam as the same one. Written as the ESCAPE — the raw byte makes git treat the
// file as binary and every scanner in this repo goes blind to it (rule `typescript`).
function heldOutKey(frame: Pick<CampaignFrame, "scenarios">): string {
  return [...new Set(frame.scenarios.filter((s) => s.heldOut === true).map((s) => s.id))].sort().join("\u0000");
}

export class CampaignService {
  private readonly newId: () => string;
  private readonly now: () => string;
  constructor(private readonly deps: CampaignServiceDeps) {
    this.newId = deps.newId ?? (() => `evc_${Math.random().toString(36).slice(2, 12)}`);
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async open(tenant: string, input: NewCampaignInput, by: string): Promise<EvolutionCampaignRecord> {
    // The issue is resolved BEFORE the campaign exists — a campaign journaling into a ghost would strand
    // its narrative; `get` throws NotFound and the open refuses with it.
    const issue = await this.deps.issues.get(tenant, input.issueId);
    // …and it is still the issue the caller was authorized over. `expectedIssueTeamId === undefined` inside a
    // declared expectation is a real claim ("it was unowned when I was cleared"), which is why the presence of
    // the FIELD is what enables the check rather than the presence of a team.
    if ("expectedIssueTeamId" in input && issue.teamId !== input.expectedIssueTeamId)
      throw new ConflictError(
        "CONFLICT",
        { issue: input.issueId, authorized: input.expectedIssueTeamId ?? null, current: issue.teamId ?? null },
        "this issue changed teams while the campaign was being opened — read it back and open again",
      );
    // …and if this campaign says it CONTINUES another, the claim is verified before anything is written.
    // Open is the only moment the answer can change anything: after it the frame is frozen and its rounds are
    // judged at a level nobody may revise.
    await this.assertChainIsHonest(tenant, input.frame);
    const record: EvolutionCampaignRecord = {
      id: this.newId(),
      tenant,
      issueId: issue.id,
      ...(issue.teamId !== undefined ? { teamId: issue.teamId } : {}),
      frame: input.frame,
      frameDigest: contentDigest(input.frame),
      rounds: [],
      state: "open",
      createdBy: by,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const fact: DomainFact = {
      kind: "campaign.opened",
      subject: { type: "campaign", id: record.id },
      actor: by,
      payload: {
        id: record.id,
        issueId: record.issueId,
        subjectType: input.frame.subject.type,
        subjectId: input.frame.subject.id,
        baselineVersion: input.frame.subject.baselineVersion,
      },
    };
    await this.deps.store.create(record, this.stamped(tenant, [fact]));
    return record;
  }

  // ── A CHAIN IS ONE EXAM SPENT ACROSS SEVERAL CAMPAIGNS ──────────────────────────────────────────
  //
  // `heldOutFamilySize` corrects the tests ONE campaign spends against its frozen held-out rows. A successor
  // that reuses those rows spends more tests against the same population, and a per-campaign family cannot
  // see them — so the correction this repo just bought would leak straight back out through the walk it
  // exists to make honest.
  //
  // Six claims, and each is refused rather than assumed. Five are about whether this is the same exam at all;
  // the sixth is the arithmetic. A caller who cannot satisfy them has a fresh campaign, not a chain — which
  // is the honest shape and stays available by simply omitting `continues`.
  private async assertChainIsHonest(tenant: string, frame: CampaignFrame): Promise<void> {
    const predecessorId = frame.continues;
    if (predecessorId === undefined) return;
    const family = frame.significance.heldOutFamilySize;
    if (family === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { continues: predecessorId },
        "a campaign that continues another must declare significance.heldOutFamilySize — the family is what the chain is spending, so a chain without one is a correction that stops at the first campaign",
      );

    // Walk the ancestors, counting the rounds already spent against these rows. Bounded and cycle-guarded:
    // `continues` is caller-authored, and an unbounded walk over caller-authored links is an outage with a
    // comment. `get` throws NotFound, so a chain naming a ghost refuses here rather than opening.
    const parent = await this.get(tenant, predecessorId);
    const seen = new Set<string>([predecessorId]);
    let spent = parent.rounds.length;
    let cursor = parent.frame.continues;
    while (cursor !== undefined) {
      if (seen.has(cursor) || seen.size >= MAX_CHAIN_LINKS)
        throw new BadRequestError(
          "BAD_REQUEST",
          { continues: predecessorId, at: cursor, links: seen.size },
          `the chain from '${predecessorId}' does not terminate within ${MAX_CHAIN_LINKS} links`,
        );
      seen.add(cursor);
      const ancestor = await this.get(tenant, cursor);
      spent += ancestor.rounds.length;
      cursor = ancestor.frame.continues;
    }

    // 1. It continues a RESULT. A campaign that halted proved nothing to carry forward, and one still open
    //    has not finished spending its own share of the family.
    const outcome = parent.close?.outcome;
    if (outcome === undefined || outcome.kind !== "adopted")
      throw new ConflictError(
        "CONFLICT",
        { continues: parent.id, state: parent.state },
        `campaign '${parent.id}' adopted nothing, so there is no version to continue from — a chain continues a result, not an attempt`,
      );
    // 2. …of the same subject, and 3. from the version that result named. A "chain" starting somewhere else
    //    is two campaigns sharing an exam, which is exactly the thing the family cannot account for.
    if (parent.frame.subject.type !== frame.subject.type || parent.frame.subject.id !== frame.subject.id)
      throw new BadRequestError(
        "BAD_REQUEST",
        { continues: parent.id },
        `campaign '${parent.id}' optimized ${parent.frame.subject.type} '${parent.frame.subject.id}' and this one optimizes ${frame.subject.type} '${frame.subject.id}' — a chain follows one subject`,
      );
    if (frame.subject.baselineVersion !== outcome.version)
      throw new BadRequestError(
        "BAD_REQUEST",
        { continues: parent.id, adopted: outcome.version, baseline: frame.subject.baselineVersion },
        `this campaign baselines ${frame.subject.baselineVersion} and '${parent.id}' adopted ${outcome.version} — a chain starts from what its predecessor proved`,
      );
    // 4. The same held-out rows. Different rows are a different exam, the predecessor's tests were spent
    //    against a population this campaign is not touching, and carrying the count would be arithmetic
    //    about the wrong thing.
    if (heldOutKey(parent.frame) !== heldOutKey(frame))
      throw new BadRequestError(
        "BAD_REQUEST",
        { continues: parent.id },
        `the held-out scenarios differ from '${parent.id}' — that is a different exam, so its tests do not carry. Open a fresh campaign instead of continuing this one`,
      );
    // 5. One pre-registration for the whole chain. Two levels would mean rounds in one walk judged by two
    //    rules, which is the thing freezing a frame exists to prevent, spread across campaigns.
    if (
      parent.frame.significance.fdrAlpha !== frame.significance.fdrAlpha ||
      parent.frame.significance.heldOutFamilySize !== family
    )
      throw new BadRequestError(
        "BAD_REQUEST",
        { continues: parent.id },
        `a chain shares one pre-registration — '${parent.id}' declared fdrAlpha ${parent.frame.significance.fdrAlpha ?? "none"} over a family of ${parent.frame.significance.heldOutFamilySize ?? "none"}, and this frame declares ${frame.significance.fdrAlpha ?? "none"} over ${family}`,
      );
    // 6. …and the arithmetic. This is the whole point: the chain's rounds all test the same rows, so the
    //    family has to cover them together.
    if (spent + frame.budget.maxRounds > family)
      throw new BadRequestError(
        "BAD_REQUEST",
        { continues: parent.id, spent, budget: frame.budget.maxRounds, family },
        `this chain has spent ${spent} of its ${family} pre-registered held-out tests and this campaign budgets ${frame.budget.maxRounds} more — raise heldOutFamilySize on a new chain (accepting the smaller per-round level it buys), or start a fresh campaign on held-out rows that have not been asked yet`,
      );
  }

  async get(tenant: string, id: string): Promise<EvolutionCampaignRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, "campaign not found");
    return record;
  }

  async list(tenant: string, visibleTeams?: string[]): Promise<EvolutionCampaignRecord[]> {
    return this.deps.store.list(tenant, visibleTeams);
  }

  // The pure gate over the current trace — a read, never an effect.
  // ── A LEGACY FRAME MAY BE READ, NEVER DECIDED ON (arch-review 75 P1-high) ────────────────────────
  //
  // arch-review 72 split creation from storage so a campaign written before the held-out rule stays
  // readable. That was right, and it left the other half open: such a campaign is still `open`, and nothing
  // stopped it logging a NEW round after the upgrade — the round carries a `heldOut` block built from the
  // frame's single flag, and the gate adopts on evidence the current rule forbids.
  //
  // So reads stay permissive and every DECISION and MUTATION re-checks the frame against the rule in force.
  // The refusal names the remedy, because "open a new campaign" is the only thing a caller can do: the frame
  // is frozen by construction, so an ineligible one cannot be repaired in place.
  private requireEligibleFrame(record: EvolutionCampaignRecord): void {
    const defects = campaignFrameDefects(record.frame);
    if (defects.length === 0) return;
    throw new ConflictError(
      "CONFLICT",
      { campaign: record.id, defects },
      `this campaign's frame predates the current adoption rules (${defects.join("; ")}) — it stays readable, but it may not produce new adoption evidence. Open a new campaign with a conforming frame`,
    );
  }

  async decision(tenant: string, id: string): Promise<CampaignGateAnswer> {
    const record = await this.get(tenant, id);
    this.requireEligibleFrame(record);
    return campaignAdoption(record.frame, record.rounds);
  }

  async logRound(
    tenant: string,
    id: string,
    input: NewRoundInput,
    by: string,
    access: TeamAccess,
  ): Promise<{ record: EvolutionCampaignRecord; round: CampaignRound; answer: CampaignGateAnswer }> {
    const record = await this.get(tenant, id);
    if (record.state !== "open")
      throw new ConflictError("CONFLICT", { state: record.state }, "the campaign is closed — open a new one");
    // …and the frame still has to satisfy the rules in force, or this round would MANUFACTURE the held-out
    // block a legacy frame could never have produced before the upgrade (arch-review 75 P1-high).
    this.requireEligibleFrame(record);
    // The verdict is DERIVED from the production diff. A missing/unfinished/invisible scorecard throws
    // inside the read (requireSucceeded, under the caller's team ceiling) and the round is refused with that
    // reason — never logged half-known (L2), never read around the team axis.
    // ── AND IT IS JUDGED AT THE LEVEL THE FRAME PRE-REGISTERED, DIVIDED BY THE FAMILY ──────────────
    //
    // `fdrAlpha` corrects across the CASES of this round — the only family the diff can see. A campaign asks
    // a second one it cannot: the same frozen held-out population, once per round, any round able to end the
    // walk. Nothing was correcting for that, so a ten-round campaign at alpha 0.05 over three held-out cases
    // adopted a null candidate about half the time, and `budget.maxRounds` — a spending cap — was the only
    // thing bounding it.
    //
    // The division happens HERE, at the one seam that derives a verdict, from a size frozen at open. Doing it
    // at the gate instead would judge rounds already recorded by a level chosen after they ran.
    const { fdrAlpha, minDelta, heldOutFamilySize } = record.frame.significance;
    if (fdrAlpha === undefined || heldOutFamilySize === undefined)
      // Unreachable: `requireEligibleFrame` above refuses a frame declaring neither, on every path that
      // produces new evidence. An exhaustiveness assertion, not a guard with its own reachable failure —
      // the refusal that can actually fire is the eligibility one, and that is where its rung belongs.
      throw new ConflictError(
        "CONFLICT",
        { campaign: id },
        "this campaign's frame declares no significance level or held-out family",
      );
    const snapshot = await this.deps.diffs.diffSnapshot(tenant, input.baselineScorecardId, input.candidateScorecardId, {
      ...(minDelta !== undefined ? { minDelta } : {}),
      fdrAlpha: fdrAlpha / heldOutFamilySize,
      ...(access.visibleTeams !== undefined ? { visibleTeams: access.visibleTeams } : {}),
    });
    // IDENTITY is refused, not recorded: a round whose declared coordinates disagree with what the
    // scorecards actually evaluated is a mislabeled request, and logging it would let the loop name the
    // graduate (L3 — the scorecard's own harness stamp is the source).
    const expectedId =
      record.frame.subject.type === "harness" ? record.frame.subject.id : `agent:${record.frame.subject.id}`;
    const refuse = (what: string, extra: Record<string, unknown>): never => {
      throw new BadRequestError("BAD_REQUEST", extra, what);
    };
    const baselineHarness = snapshot.baseline.record.harness;
    const candidateHarness = snapshot.candidate.record.harness;
    if (candidateHarness.id !== expectedId || baselineHarness.id !== expectedId)
      refuse(
        `the compared scorecards evaluated '${baselineHarness.id}'/'${candidateHarness.id}', not the campaign's subject '${expectedId}'`,
        { expectedId, baseline: baselineHarness, candidate: candidateHarness },
      );
    if (candidateHarness.version !== input.candidateVersion)
      refuse(
        `the candidate scorecard evaluated ${expectedId}@${candidateHarness.version}, not the declared candidate ${input.candidateVersion}`,
        { declared: input.candidateVersion, actual: candidateHarness.version },
      );
    if (baselineHarness.version !== record.frame.subject.baselineVersion)
      refuse(
        `the baseline scorecard evaluated ${expectedId}@${baselineHarness.version}, not the frame's baseline ${record.frame.subject.baselineVersion}`,
        { frame: record.frame.subject.baselineVersion, actual: baselineHarness.version },
      );
    const round: CampaignRound = {
      seq: record.rounds.length + 1,
      hypothesis: input.hypothesis,
      candidateVersion: input.candidateVersion,
      baselineScorecardId: input.baselineScorecardId,
      candidateScorecardId: input.candidateScorecardId,
      verdict: verdictOf(snapshot, record.frame),
      at: this.now(),
      by,
    };
    const fact: DomainFact = {
      kind: "campaign.round_logged",
      subject: { type: "campaign", id },
      actor: by,
      payload: {
        id,
        seq: round.seq,
        candidateVersion: round.candidateVersion,
        improvements: round.verdict.significantImprovements,
        regressions: round.verdict.significantRegressions,
        comparable: round.verdict.comparable,
      },
    };
    const outcome = await this.deps.store.appendRound(
      tenant,
      id,
      round,
      record.rounds.length,
      this.stamped(tenant, [fact]),
    );
    switch (outcome.kind) {
      case "appended": {
        const rounds = [...record.rounds, round];
        return { record: { ...record, rounds }, round, answer: campaignAdoption(record.frame, rounds) };
      }
      case "conflict":
        throw new ConflictError(
          "CONFLICT",
          { expected: outcome.expected, actual: outcome.actual },
          "a concurrent round landed first — re-read the campaign and log against its current state",
        );
      case "terminal":
        throw new ConflictError("CONFLICT", { state: outcome.state }, "the campaign closed while this round ran");
      case "absent":
        throw new NotFoundError("NOT_FOUND", { id }, "campaign not found");
      default:
        return assertNever(outcome);
    }
  }

  // Settle per the gate's answer: adopt closes as adopted, a campaign-ending halt closes as that halt, and
  // everything else REFUSES — `continue` because the loop is not done, `identity_unverified` because the fix
  // is another round (pin the image / verified lane), not an ending. The caller receives the gate's answer
  // verbatim; a human approving an adoption approves THIS, not a summary the loop wrote about itself.
  async settle(
    tenant: string,
    id: string,
    by: string,
  ): Promise<{ record: EvolutionCampaignRecord; answer: CampaignGateAnswer }> {
    const record = await this.get(tenant, id);
    if (record.state !== "open")
      throw new ConflictError("CONFLICT", { state: record.state }, "the campaign already settled");
    this.requireEligibleFrame(record);
    const answer = campaignAdoption(record.frame, record.rounds);
    if (answer.kind === "continue")
      throw new ConflictError(
        "CONFLICT",
        { answer },
        "the gate answers continue — the campaign settles only on an adoptable candidate or its own ending",
      );
    let state: "adopted" | "no_improvement" | "budget_exhausted";
    let close: NonNullable<EvolutionCampaignRecord["close"]>;
    // ── THE AUTHORIZATION THE CLOSE OWES (arch-review 71 P0-evolution) ───────────────────────────────
    //
    // A close that says `adopted` and executes nothing leaves four silent states — settle-then-crash with no
    // capability, a save with no gate, C1 evaluated with C2 saved, and an issue nobody resolved. The proof is
    // minted from the round that proved it and the frozen frame, and the operation carrying it is written in
    // the SAME statement as the close, so `adopted` and "somebody owes a registration" are one durable fact.
    const proof = adoptionProofOf(answer, record, record.rounds);
    const adoption: AdoptionOperation | undefined =
      proof === undefined
        ? undefined
        : {
            operationId: `adopt/${record.tenant}/${record.id}`,
            tenant: record.tenant,
            proof,
            state: "decided",
            createdAt: this.now(),
            updatedAt: this.now(),
          };
    // ── …AND `adopted` WITH NOTHING TO SPEND IS UNREPRESENTABLE (arch-review 73 P0) ─────────────────
    //
    // ⚠️ UNREACHABLE BY CONSTRUCTION, and deliberately not a protocol-mutation rung: the gate refuses an
    // adoption it cannot authorize, and `adoptionProofOf` only declines an `adopt` answer when the trace is
    // empty — which no adopt answer can be. This is an exhaustiveness assertion in the same category as the
    // `assertNever` below, NOT a guard with a counterexample. Writing a rung for it would add a mutation no
    // suite can turn red, which is a worse lie than no rung (rule `testing`).
    //
    // It stands because of how the state came back: arch-review 72 put the byte-naming refusal in the proof
    // minter and left `campaignAdoption` answering `adopt`, and the close went through carrying
    // `adoption: undefined` — arch-review 71's abolished state, reopened one commit later at the same seam,
    // green in every suite. The decision is the gate's; this is the write refusing to be the place that
    // state can re-enter through.
    if (answer.kind === "adopt" && proof === undefined)
      throw new ConflictError(
        "CONFLICT",
        { answer },
        "the gate adopted but authorized nothing — closing 'adopted' with no operation would leave a campaign claiming a version no registry write may claim it proved",
      );
    if (answer.kind === "adopt") {
      state = "adopted";
      close = {
        outcome: {
          kind: "adopted",
          version: answer.version,
          provingScorecardId: answer.provingScorecardId,
          waivedAxes: answer.waivedAxes,
          // …and WHICH BYTES were proved (arch-review 71 P0-evolution). A close that names only a label
          // cannot be checked against whatever a registry later holds under that label, so a candidate
          // substituted between the evaluation and the save is undetectable.
          ...(answer.candidateSpecDigest !== undefined ? { candidateSpecDigest: answer.candidateSpecDigest } : {}),
        },
        at: this.now(),
        by,
      };
    } else {
      if (answer.reason === "identity_unverified")
        throw new ConflictError(
          "CONFLICT",
          { answer },
          `adoption refused: ${answer.detail}. The campaign stays open — fix the provenance and run another round`,
        );
      state = answer.reason;
      close = { outcome: { kind: "halted", reason: answer.reason, detail: answer.detail }, at: this.now(), by };
    }
    const fact: DomainFact = {
      kind: "campaign.closed",
      subject: { type: "campaign", id },
      actor: by,
      payload: {
        id,
        state,
        subjectId: record.frame.subject.id,
        ...(answer.kind === "adopt" ? { version: answer.version, provingScorecardId: answer.provingScorecardId } : {}),
      },
    };
    const outcome = await this.deps.store.close(
      tenant,
      id,
      state,
      close,
      record.rounds.length,
      this.stamped(tenant, [fact]),
      // …and the authorization, in the same statement. A refused close (already settled, or a round landed
      // since the gate's read) authorizes nothing.
      adoption,
    );
    switch (outcome.kind) {
      case "closed":
        return { record: { ...record, state, close, updatedAt: this.now() }, answer };
      case "already":
        throw new ConflictError("CONFLICT", { state: outcome.state }, "another settle won — read the campaign back");
      case "conflict":
        // A round landed between the gate's read and this close — the answer was computed over a shorter
        // trace than the one being closed. Re-read and settle over the trace as it now is.
        throw new ConflictError(
          "CONFLICT",
          { expected: outcome.expected, actual: outcome.actual },
          "a round landed after the gate's read — the answer is stale; re-read the campaign and settle again",
        );
      case "absent":
        throw new NotFoundError("NOT_FOUND", { id }, "campaign not found");
      default:
        return assertNever(outcome);
    }
  }

  // What this campaign authorized, and whether anybody has spent it yet. The read a registry write needs
  // before it can present a proof — and the read an operator needs to see that a settle crashed before its
  // registration landed. An absent operation is a real answer, not a failure: a halted campaign authorized
  // nothing, and the caller is told which of the two it is looking at.
  async adoption(
    tenant: string,
    id: string,
  ): Promise<{ campaign: EvolutionCampaignRecord; operation: AdoptionOperation | undefined }> {
    const campaign = await this.get(tenant, id); // unknown campaign → NotFound, before any operation read
    return { campaign, operation: await this.deps.operations.forCampaign(tenant, id) };
  }

  private stamped(tenant: string, facts: DomainFact[]) {
    return stampFacts(tenant, facts, { newId: this.newId, now: this.now }).map((f) => f.record);
  }
}

// The round's verdict, summarized from the production diff's answer AND checked against the FRAME — the
// frozen exam. `comparable: false` marks a pair that produced no usable signal for THIS campaign: no
// statistics, a confounded world, or a run that drifted off the frame's scenarios/trials/judges. Such a
// round can never adopt and counts as rejected; the detail names why, so the trace explains itself.
function verdictOf(snapshot: CampaignSnapshot, frame: CampaignFrame): CampaignRound["verdict"] {
  const comparison = snapshot.diff;
  // Identity coverage first: an absent identity read is NOT "verified" (L2) — it blocks like an unverified
  // axis until the diff can say what it compared.
  const unverifiedAxes =
    comparison.experiment === undefined
      ? ["experiment_identity_unavailable"]
      : comparison.experiment.unverified.map((u) => u.axis);
  // Axes VERIFIED different — stronger than unverified, never waivable: a delta across different worlds is
  // not evidence about the change under test (the axis's own sentence).
  const confoundedAxes = comparison.experiment === undefined ? [] : comparison.experiment.confounds.map((c) => c.axis);
  const rejected = (detail: string): CampaignRound["verdict"] => ({
    comparable: false,
    significantImprovements: 0,
    significantRegressions: 0,
    unverifiedAxes,
    confoundedAxes,
    detail,
  });
  if (comparison.comparability === "none")
    return rejected("the pair is not comparable (verdict-policy mismatch or an unresolvable stamp)");
  if (confoundedAxes.length > 0)
    return rejected(`the comparison is confounded — ${confoundedAxes.join(", ")} verifiably differ between the sides`);
  if (comparison.trials === undefined)
    return rejected("no trial signal — campaign statistics need repeated trials on both sides");
  // FRAME CONFORMANCE — the exam is the frame's, not the round's (the reason the frame is frozen at open):
  // the compared cases must be exactly the frame's scenarios, at no less than the frame's trials.
  const compared = new Set(comparison.trials.cases.map((c) => c.caseId));
  const framed = new Set(frame.scenarios.map((sc) => sc.id));
  const missing = [...framed].filter((cid) => !compared.has(cid));
  const extra = [...compared].filter((cid) => !framed.has(cid));
  if (missing.length > 0 || extra.length > 0)
    return rejected(
      `the compared scenarios are not the frame's (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  const thin = comparison.trials.cases.filter(
    (c) => c.baselineTrials < frame.trialsPerCase || c.candidateTrials < frame.trialsPerCase,
  );
  if (thin.length > 0)
    return rejected(
      `${thin.length} case(s) ran fewer than the frame's ${frame.trialsPerCase} trials (${thin
        .slice(0, 5)
        .map((c) => c.caseId)
        .join(", ")})`,
    );
  if (frame.judges.length > 0) {
    const want = [...frame.judges].sort().join(",");
    const judgesOf = (side: CampaignComparisonSide): string =>
      (side.record.orchestration?.judges ?? [])
        .map((j) => j.id)
        .sort()
        .join(",");
    if (judgesOf(snapshot.baseline) !== want || judgesOf(snapshot.candidate) !== want)
      return rejected(
        `the judges are not the frame's (frame: ${want || "none"}; baseline: ${judgesOf(snapshot.baseline) || "none"}; candidate: ${judgesOf(snapshot.candidate) || "none"})`,
      );
  }
  const significant = comparison.trials.cases.filter((c) => c.significant);
  // ── …AND THE HELD-OUT POPULATION, COUNTED APART (arch-review 71 P1-high) ──────────────────────────
  //
  // The whole-round counts are the loop's own feedback: it has been optimizing against the training
  // scenarios, so improving there is evidence about the SEARCH, not about the capability. Adoption
  // authority reads the held-out block (`campaignAdoption`), and this is where the frame's annotation
  // finally decides something.
  const heldOutIds = new Set(frame.scenarios.filter((sc) => sc.heldOut).map((sc) => sc.id));
  const heldOutCases = significant.filter((c) => heldOutIds.has(c.caseId));
  return {
    comparable: true,
    significantImprovements: significant.filter((c) => c.delta > 0).length,
    significantRegressions: significant.filter((c) => c.delta < 0).length,
    heldOut: {
      improvements: heldOutCases.filter((c) => c.delta > 0).length,
      regressions: heldOutCases.filter((c) => c.delta < 0).length,
    },
    // …and the exact bytes evaluated, so an adopted label can be checked against what a registry holds
    // under it (arch-review 71 P0-evolution).
    ...(snapshot.candidate.record.manifest?.harness?.specDigest !== undefined
      ? { candidateSpecDigest: snapshot.candidate.record.manifest.harness.specDigest }
      : {}),
    // …and the candidate's own judges on whether its account holds up (arch-review 71 P1-evolution).
    ...(observationsOf(snapshot.candidate) !== undefined ? { observations: observationsOf(snapshot.candidate) } : {}),
    unverifiedAxes,
    confoundedAxes,
  };
}

function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}
