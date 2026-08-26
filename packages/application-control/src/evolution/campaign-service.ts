import type { CampaignFrame, CampaignRound, DomainFact, EvolutionCampaignRecord } from "@everdict/contracts";
import { ConflictError, NotFoundError } from "@everdict/contracts";
import type { ExperimentIdentity, TrialDiff } from "@everdict/domain";
import { type CampaignGateAnswer, campaignAdoption, contentDigest } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { EvolutionCampaignStore } from "../ports/evolution-campaign-store.js";

// ── THE CAMPAIGN SERVICE (docs/architecture/evolution-lineage.md, Track D) ───────────────────────────
//
// The agent-evolve loop's settlement owner. The frame is frozen at open (digest recorded); every round's
// VERDICT is derived here from the one production diff predicate — trials significance + experiment
// identity — never accepted from the caller, which would let the loop write its own report card (L3); and
// the close is the pure gate's answer made durable. The ISSUE beside it stays the journal and intent hub.

// What the service reads off the production diff. Structural, so the real ScorecardAnalyticsService.diff
// satisfies it without this package depending on the facade's whole surface.
export interface CampaignComparison {
  comparability: "full" | "partial" | "none";
  trials?: TrialDiff;
  experiment?: ExperimentIdentity;
}

export interface CampaignServiceDeps {
  store: EvolutionCampaignStore;
  // The intent hub the campaign journals into — an unreadable issue refuses the open (its `get` throws).
  issues: { get(tenant: string, ref: string): Promise<{ id: string }> };
  // THE diff predicate (ScorecardAnalyticsService.diff) — policy-resolved transitions, trial statistics,
  // experiment identity. One owner; this service only summarizes its answer into the round's verdict.
  diffs: {
    diff(
      tenant: string,
      baselineId: string,
      candidateId: string,
      opts?: { minDelta?: number; fdrAlpha?: number },
    ): Promise<CampaignComparison>;
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
  ): Promise<{ record: EvolutionCampaignRecord; round: CampaignRound; answer: CampaignGateAnswer }> {
    const record = await this.get(tenant, id);
    if (record.state !== "open")
      throw new ConflictError("CONFLICT", { state: record.state }, "the campaign is closed — open a new one");
    // The verdict is DERIVED from the production diff. A missing/unfinished scorecard throws inside diff
    // (requireSucceeded) and the round is refused with that reason — never logged half-known (L2).
    const comparison = await this.deps.diffs.diff(tenant, input.baselineScorecardId, input.candidateScorecardId, {
      ...(record.frame.significance.minDelta !== undefined ? { minDelta: record.frame.significance.minDelta } : {}),
      ...(record.frame.significance.fdrAlpha !== undefined ? { fdrAlpha: record.frame.significance.fdrAlpha } : {}),
    });
    const round: CampaignRound = {
      seq: record.rounds.length + 1,
      hypothesis: input.hypothesis,
      candidateVersion: input.candidateVersion,
      baselineScorecardId: input.baselineScorecardId,
      candidateScorecardId: input.candidateScorecardId,
      verdict: verdictOf(comparison),
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
    if (answer.kind === "adopt") {
      state = "adopted";
      close = {
        outcome: {
          kind: "adopted",
          version: answer.version,
          provingScorecardId: answer.provingScorecardId,
          waivedAxes: answer.waivedAxes,
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
    const outcome = await this.deps.store.close(tenant, id, state, close, this.stamped(tenant, [fact]));
    switch (outcome.kind) {
      case "closed":
        return { record: { ...record, state, close, updatedAt: this.now() }, answer };
      case "already":
        throw new ConflictError("CONFLICT", { state: outcome.state }, "another settle won — read the campaign back");
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

// The round's verdict, summarized from the production diff's answer. `comparable: false` marks a pair that
// produced no significance signal at all — such a round can never adopt and counts as rejected.
function verdictOf(comparison: CampaignComparison): CampaignRound["verdict"] {
  // Identity coverage first: an absent identity read is NOT "verified" (L2) — it blocks like an unverified
  // axis until the diff can say what it compared.
  const unverifiedAxes =
    comparison.experiment === undefined
      ? ["experiment_identity_unavailable"]
      : comparison.experiment.unverified.map((u) => u.axis);
  if (comparison.comparability === "none")
    return {
      comparable: false,
      significantImprovements: 0,
      significantRegressions: 0,
      unverifiedAxes,
      detail: "the pair is not comparable (verdict-policy mismatch or an unresolvable stamp)",
    };
  if (comparison.trials === undefined)
    return {
      comparable: false,
      significantImprovements: 0,
      significantRegressions: 0,
      unverifiedAxes,
      detail: "no trial signal — campaign statistics need repeated trials on both sides",
    };
  const significant = comparison.trials.cases.filter((c) => c.significant);
  return {
    comparable: true,
    significantImprovements: significant.filter((c) => c.delta > 0).length,
    significantRegressions: significant.filter((c) => c.delta < 0).length,
    unverifiedAxes,
  };
}

function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}
