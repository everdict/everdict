import type { CampaignFrame, CampaignRound, DomainFact, EvolutionCampaignRecord } from "@everdict/contracts";
import {
  type AdoptionOperation,
  BadRequestError,
  ConflictError,
  NotFoundError,
  type Score,
  isMeasured,
} from "@everdict/contracts";
import type { ExperimentIdentity, TrialDiff } from "@everdict/domain";
import { type CampaignGateAnswer, adoptionProofOf, campaignAdoption, contentDigest } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { EvolutionCampaignStore } from "../ports/evolution-campaign-store.js";

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
function observationsOf(side: CampaignComparisonSide): { divergent: number; unclear: number } | undefined {
  const results = side.record.scorecard?.results;
  if (results === undefined) return undefined;
  let divergent = 0;
  let unclear = 0;
  // THROUGH THE MEASURED GATE, like every other consumer of `.scores` (rule `suite`). An `unmeasured` row
  // is a grader failure, not a judgment about the agent — it carries no assessment, and counting one would
  // be reading a verdict out of an absence.
  for (const r of results)
    for (const sc of r.scores.filter(isMeasured)) {
      if (sc.observationAssessment?.status === "divergent") divergent += 1;
      if (sc.observationAssessment?.status === "unclear") unclear += 1;
    }
  return { divergent, unclear };
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
  issues: { get(tenant: string, ref: string): Promise<{ id: string }> };
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
  newId?: () => string;
  now?: () => string;
}

export interface NewCampaignInput {
  issueId: string;
  frame: CampaignFrame;
}

export interface NewRoundInput {
  hypothesis: string;
  candidateVersion: string;
  baselineScorecardId: string;
  candidateScorecardId: string;
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
    const record: EvolutionCampaignRecord = {
      id: this.newId(),
      tenant,
      issueId: issue.id,
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

  async get(tenant: string, id: string): Promise<EvolutionCampaignRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, "campaign not found");
    return record;
  }

  async list(tenant: string): Promise<EvolutionCampaignRecord[]> {
    return this.deps.store.list(tenant);
  }

  // The pure gate over the current trace — a read, never an effect.
  async decision(tenant: string, id: string): Promise<CampaignGateAnswer> {
    const record = await this.get(tenant, id);
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
    // The verdict is DERIVED from the production diff. A missing/unfinished/invisible scorecard throws
    // inside the read (requireSucceeded, under the caller's team ceiling) and the round is refused with that
    // reason — never logged half-known (L2), never read around the team axis.
    const snapshot = await this.deps.diffs.diffSnapshot(tenant, input.baselineScorecardId, input.candidateScorecardId, {
      ...(record.frame.significance.minDelta !== undefined ? { minDelta: record.frame.significance.minDelta } : {}),
      ...(record.frame.significance.fdrAlpha !== undefined ? { fdrAlpha: record.frame.significance.fdrAlpha } : {}),
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
