import {
  type ChangeCampaignClose,
  type ChangeCampaignRecord,
  type ChangeCriterion,
  type ChangeJudgementAnswer,
  type ChangeRound,
  type ChangeSetEntry,
  ConflictError,
  NotFoundError,
} from "@everdict/contracts";
import {
  assertAnswersCoverCriteria,
  assertClosable,
  assertCommitsUnclaimed,
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
}

export interface LogChangeRoundInput {
  hypothesis: string;
  changes: ChangeSetEntry[];
  answers: ChangeJudgementAnswer[];
  checkpointId?: string;
  learned?: string;
}

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
    const at = this.now();
    const record: ChangeCampaignRecord = {
      id: this.newId(),
      tenant,
      issueId: input.issueId,
      service: { repository: input.service.repository, ...(input.service.path ? { path: input.service.path } : {}) },
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
    assertAnswersCoverCriteria(campaign.criteria, input.answers);
    assertCommitsUnclaimed(campaign.rounds, input.changes);

    const round: ChangeRound = {
      seq: campaign.rounds.length + 1,
      hypothesis: input.hypothesis,
      changes: input.changes,
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

  private async require(tenant: string, id: string): Promise<ChangeCampaignRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `change campaign '${id}' not found.`);
    return record;
  }
}
