import {
  BadRequestError,
  type ChangeCampaignClose,
  type ChangeCampaignRecord,
  type ChangeCriterion,
  type ChangeJudgementAnswer,
  type ChangeRound,
  type ChangeSetEntry,
  ConflictError,
  type GateRun,
  NotFoundError,
} from "@everdict/contracts";
import {
  assertAnswersCoverCriteria,
  assertClosable,
  assertCommitsUnclaimed,
  assertObservationsMeasured,
  deriveRoundOutcome,
} from "@everdict/domain";
import type { ChangeCampaignStore } from "../ports/change-campaign-store.js";

export interface ChangeCampaignServiceDeps {
  store: ChangeCampaignStore;
  newId?: () => string;
  now?: () => string;
}

export interface OpenChangeCampaignInput {
  issueId: string;
  service: { repository: string; path?: string };
  criteria: ChangeCriterion[];
  // The campaign this one continues — the remainder of a `partially_adopted` predecessor, or a second attempt
  // after an abandonment.
  continues?: string;
}

export interface LogChangeRoundInput {
  hypothesis: string;
  changes: ChangeSetEntry[];
  gateRuns?: GateRun[];
  answers: ChangeJudgementAnswer[];
  checkpointId?: string;
  learned?: string;
}

// How far the chain walk follows `continues`. Bounded because the data could be cyclic and a lineage read
// must not hang on it; the visited set makes a cycle terminate, this makes a LONG one terminate too.
const MAX_CHAIN = 50;

// The `change` grade's use-cases (docs/architecture/change-campaign-spec.md). The service composes the
// domain's refusals and consumes the store's conditional writes; it decides nothing the domain can decide.
export class ChangeCampaignService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: ChangeCampaignServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async open(tenant: string, actor: string, input: OpenChangeCampaignInput): Promise<ChangeCampaignRecord> {
    // ONE OPEN CAMPAIGN PER ISSUE (maintainer, 2026-09-17). A request's attempts are a CHAIN — the successor
    // names what it continues — rather than a set nobody can order. It is also what makes "which attempt
    // changed this commit" answerable across the whole walk instead of only inside one campaign.
    const existing = (await this.deps.store.list(tenant, { issueId: input.issueId })).find((c) => c.state === "open");
    if (existing !== undefined)
      throw new ConflictError(
        "CONFLICT",
        { issueId: input.issueId, openCampaignId: existing.id },
        `issue '${input.issueId}' already has an open change campaign (${existing.id}) — close it (adopted · partially_adopted · abandoned) and open the next one naming it in \`continues\`.`,
      );
    if (input.continues !== undefined) {
      const predecessor = await this.deps.store.get(tenant, input.continues);
      if (predecessor === undefined)
        throw new BadRequestError(
          "BAD_REQUEST",
          { continues: input.continues },
          `campaign '${input.continues}' does not exist — a chain that names a missing predecessor is a chain nobody can walk.`,
        );
      if (predecessor.state === "open")
        throw new BadRequestError(
          "BAD_REQUEST",
          { continues: input.continues },
          "a campaign continues one that has ENDED — continuing an open campaign would make two of them live for one request.",
        );
    }
    const at = this.now();
    const record: ChangeCampaignRecord = {
      id: this.newId(),
      tenant,
      issueId: input.issueId,
      service: { repository: input.service.repository, ...(input.service.path ? { path: input.service.path } : {}) },
      ...(input.continues !== undefined ? { continues: input.continues } : {}),
      criteria: input.criteria,
      rounds: [],
      state: "open",
      createdBy: actor,
      createdAt: at,
      updatedAt: at,
    };
    await this.deps.store.create(record);
    return record;
  }

  async logRound(
    tenant: string,
    actor: string,
    id: string,
    input: LogChangeRoundInput,
  ): Promise<{ record: ChangeCampaignRecord; round: ChangeRound }> {
    const campaign = await this.require(tenant, id);
    if (campaign.state !== "open")
      throw new ConflictError(
        "CONFLICT",
        { state: campaign.state },
        `campaign is ${campaign.state} — a round appended after the ending would describe work the close never saw.`,
      );
    const gateRuns = input.gateRuns ?? [];
    assertAnswersCoverCriteria(campaign.criteria, input.answers);
    assertObservationsMeasured(input.answers, gateRuns);
    // The CHAIN's rounds, not this campaign's: a successor could otherwise re-claim its predecessor's commits
    // and the request's lineage would show the same sha under two attempts.
    assertCommitsUnclaimed(await this.chainRounds(tenant, campaign), input.changes);

    const round: ChangeRound = {
      seq: campaign.rounds.length + 1,
      hypothesis: input.hypothesis,
      changes: input.changes,
      gateRuns,
      judgement: {
        at: this.now(),
        by: actor,
        ...(input.checkpointId !== undefined ? { checkpointId: input.checkpointId } : {}),
        answers: input.answers,
      },
      // DERIVED, never taken from the caller: the agent answers each criterion and the aggregate follows by
      // arithmetic nobody can fudge. `not_run` is not `met`, so an unreachable gate cannot be adopted through.
      outcome: deriveRoundOutcome(input.answers),
      ...(input.learned !== undefined ? { learned: input.learned } : {}),
    };

    // The boolean IS the answer to "did this land": a concurrent logger loses here, and a service that
    // ignored it would report a round it never wrote.
    const appended = await this.deps.store.appendRound(tenant, id, round, campaign.rounds.length, this.now());
    if (!appended)
      throw new ConflictError(
        "CONFLICT",
        { id, expectedRounds: campaign.rounds.length },
        "another round landed while this one was being judged — re-read the campaign and append again, so the sequence stays the record of what actually happened.",
      );
    return { record: await this.require(tenant, id), round };
  }

  async close(
    tenant: string,
    actor: string,
    id: string,
    input: Omit<ChangeCampaignClose, "at" | "by">,
  ): Promise<ChangeCampaignRecord> {
    const campaign = await this.require(tenant, id);
    assertClosable(campaign, input);
    const close: ChangeCampaignClose = { ...input, at: this.now(), by: actor };
    const closed = await this.deps.store.close(tenant, id, close, close.at);
    if (!closed)
      throw new ConflictError(
        "CONFLICT",
        { id },
        "the campaign was closed while this close was being prepared — read it and decide against the ending that actually happened.",
      );
    return this.require(tenant, id);
  }

  async get(tenant: string, id: string): Promise<ChangeCampaignRecord> {
    return this.require(tenant, id);
  }

  async list(tenant: string, options?: { issueId?: string; limit?: number }): Promise<ChangeCampaignRecord[]> {
    return this.deps.store.list(tenant, options);
  }

  // Every round this request has already recorded, walking `continues` backwards. Bounded and cycle-safe:
  // corrupt data must not turn a write path into a hang.
  private async chainRounds(tenant: string, campaign: ChangeCampaignRecord): Promise<ChangeRound[]> {
    const rounds = [...campaign.rounds];
    const seen = new Set([campaign.id]);
    let cursor = campaign.continues;
    for (let depth = 0; cursor !== undefined && depth < MAX_CHAIN; depth += 1) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const predecessor = await this.deps.store.get(tenant, cursor);
      if (predecessor === undefined) break; // a broken link is not a reason to refuse a round; it is one to stop walking
      rounds.push(...predecessor.rounds);
      cursor = predecessor.continues;
    }
    return rounds;
  }

  private async require(tenant: string, id: string): Promise<ChangeCampaignRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `change campaign '${id}' not found.`);
    return record;
  }
}
