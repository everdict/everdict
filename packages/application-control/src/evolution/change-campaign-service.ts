import {
  BadRequestError,
  type ChangeCampaignClose,
  type ChangeCampaignPage,
  type ChangeCampaignRecord,
  type ChangeCampaignSummary,
  type ChangeCampaignView,
  type ChangeCriterion,
  type ChangeJudgementAnswer,
  type ChangeRound,
  type ChangeRoundDelegation,
  type ChangeSetEntry,
  ConflictError,
  type GateRun,
  NotFoundError,
} from "@everdict/contracts";
import {
  assertAnswersCoverCriteria,
  assertClosable,
  assertCommitsUnclaimed,
  assertDeclaresARequirement,
  assertObservationsMeasured,
  deriveRoundOutcome,
  joinDelegateReportToCriteria,
  reviewDelegateReport,
  summariseRequirements,
} from "@everdict/domain";
import type { ChangeCampaignStore } from "../ports/change-campaign-store.js";
import type { DelegationReportReader, DelegationWork } from "../ports/delegation-report-reader.js";
import type { IssueRefResolver } from "../ports/issue-ref-resolver.js";

export interface ChangeCampaignServiceDeps {
  store: ChangeCampaignStore;
  // REQUIRED, not optional: what makes a campaign findable under its request is that the two sides hold the
  // same key, and an optional resolver would let a deployment file campaigns nobody can join.
  issues: IssueRefResolver;
  // How a round reaches the delegation that produced it (DEFAUL-38). OPTIONAL, and the optionality is the
  // deployment's answer rather than a shrug: a control plane with no sandbox driver cannot delegate at all,
  // and there `delegation: {required: true}` must be refused AT OPEN rather than accepted and then never
  // satisfiable. An absent reader therefore makes the delegated lane unopenable, not silently permissive.
  delegations?: DelegationReportReader;
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
  // Every round of this campaign is performed by a delegated work agent, and one that names no delegation is
  // refused. Declared here because "who did the work" decided per round, after the fact, is an annotation.
  delegation?: { required: true };
}

export interface LogChangeRoundInput {
  hypothesis: string;
  changes: ChangeSetEntry[];
  gateRuns?: GateRun[];
  answers: ChangeJudgementAnswer[];
  checkpointId?: string;
  learned?: string;
  // The sandbox session whose delegate performed this round's work. The service READS that session's report
  // and brief — it never takes them from the caller, because a supervisor who retypes a report has produced a
  // description of the work rather than a record of it (protocol L3).
  delegationRunId?: string;
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
    // What gets STORED is always the id the resolution produced — the same rule `IssueService.update` follows
    // for a parent ref. Every door accepts `ENG-12` as readily as the uuid, so without this the key a campaign
    // is filed under depends on which spelling the agent typed, and the lineage read (which asks by id) simply
    // does not find the ones typed the other way. It also makes an issue that does not exist a REFUSAL rather
    // than a campaign pinned to nothing.
    const issueId = (await this.deps.issues.get(tenant, input.issueId)).id;
    // ONE OPEN CAMPAIGN PER ISSUE (maintainer, 2026-09-17). A request's attempts are a CHAIN — the successor
    // names what it continues — rather than a set nobody can order. It is also what makes "which attempt
    // changed this commit" answerable across the whole walk instead of only inside one campaign.
    const existing = (await this.deps.store.list(tenant, { issueId })).find((c) => c.state === "open");
    if (existing !== undefined)
      throw new ConflictError(
        "CONFLICT",
        { issueId, openCampaignId: existing.id },
        `issue '${issueId}' already has an open change campaign (${existing.id}) — close it (adopted · partially_adopted · abandoned) and open the next one naming it in \`continues\`.`,
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
    // EVERY REQUIREMENT PIN IS RESOLVED HERE, for the same reason the campaign's own `issueId` is: what gets
    // stored is the id the resolution produced, never the spelling the agent typed. A criterion pinned to
    // `DIGO-12` would be invisible to every reader that asks by id — and the failure is silent, because "this
    // requirement has no criterion" and "its criterion is filed under another key" render identically.
    // Resolution also turns a requirement nobody can look up into a REFUSAL, rather than a count over issues
    // that do not exist.
    const criteria = await Promise.all(
      input.criteria.map(async (criterion) => {
        if (criterion.judges.kind !== "requirement") return criterion;
        const requirementId = (await this.deps.issues.get(tenant, criterion.judges.issueId)).id;
        return { ...criterion, judges: { kind: "requirement" as const, issueId: requirementId } };
      }),
    );
    // A campaign made only of quality gates passes without anyone saying what was asked for.
    assertDeclaresARequirement(criteria);
    // A DECLARATION THAT CANNOT BE SATISFIED IS REFUSED WHERE IT IS MADE. Without a delegation reader this
    // deployment cannot read a delegate's report, so every round of such a campaign would be refused — and
    // the author would find that out one round at a time. Refusing at open is the same rule the criteria
    // follow: the gate is settled before the work, not discovered by it.
    if (input.delegation !== undefined && this.deps.delegations === undefined)
      throw new BadRequestError(
        "NOT_CONFIGURED",
        {},
        "this deployment cannot read delegate reports, so a campaign whose rounds must be performed by a delegated work agent cannot be opened here — open it without `delegation` and log the rounds yourself.",
      );

    const at = this.now();
    const record: ChangeCampaignRecord = {
      id: this.newId(),
      tenant,
      issueId,
      service: { repository: input.service.repository, ...(input.service.path ? { path: input.service.path } : {}) },
      ...(input.continues !== undefined ? { continues: input.continues } : {}),
      criteria,
      ...(input.delegation !== undefined ? { delegation: input.delegation } : {}),
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
    // ── THE DELEGATION EDGE (DEFAUL-38) ───────────────────────────────────────────────────────────
    //
    // Everything below was already here — `reviewDelegateReport` in the domain, `DelegateReport` speaking this
    // file's own vocabulary by explicit decision, `logRound` guarding hard — and nothing called the third with
    // the first. So a supervisor read REPORT.json with their eyes, retyped the judgement, and the round could
    // not say which worker produced it. This is that call.
    const delegated = await this.delegationOf(tenant, campaign, input);
    // The delegate's own measurements come FIRST and verbatim; anything the caller carries is their own
    // verification run beside them, never a replacement for one (protocol L3 — provenance at the source).
    const gateRuns = [...(delegated?.gateRuns ?? []), ...(input.gateRuns ?? [])];
    const changes = delegated !== undefined ? delegated.changes : input.changes;
    // ⚠️ THE ANSWERS ARE THE CALLER'S, ALWAYS. There is deliberately no branch here that reads
    // `report.answers` into the judgement: a delegate whose report became the verdict would be grading its own
    // exam, and the only reason the two stay distinguishable is that they are different fields. What the
    // delegate said is recorded on `round.delegation.reported`, joined to these by criterion id.
    assertAnswersCoverCriteria(campaign.criteria, input.answers);
    assertObservationsMeasured(input.answers, gateRuns);
    // The CHAIN's rounds, not this campaign's: a successor could otherwise re-claim its predecessor's commits
    // and the request's lineage would show the same sha under two attempts.
    assertCommitsUnclaimed(await this.chainRounds(tenant, campaign), changes);

    const round: ChangeRound = {
      seq: campaign.rounds.length + 1,
      hypothesis: input.hypothesis,
      changes,
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
      ...(delegated !== undefined ? { delegation: delegated.round } : {}),
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

  async get(tenant: string, id: string): Promise<ChangeCampaignView> {
    return withRequirements(await this.require(tenant, id));
  }

  // ── A ROW IS A SUMMARY (DEFAUL-36) ────────────────────────────────────────────────────────────────
  //
  // This returned the whole view per campaign, rounds included, and nine campaigns came to 85,793 characters
  // over 1,905 lines — past the caller's output limit, spilled to a file. The rounds are the bulk and they
  // are all reachable one call away, so the row keeps what a row is FOR (which request, which service, where
  // it ended, what the request is still owed) and projects the rest into a count plus the latest verdict.
  //
  // `available` is counted rather than inferred from the page: a full page and a corpus exactly that size are
  // the same array, so a caller cannot tell "there is more" from "that was all" without being told.
  async list(tenant: string, options?: { issueId?: string; limit?: number }): Promise<ChangeCampaignPage> {
    const [records, available] = await Promise.all([
      this.deps.store.list(tenant, options),
      this.deps.store.count(tenant, options?.issueId !== undefined ? { issueId: options.issueId } : undefined),
    ]);
    return { items: records.map(summarise), available };
  }

  // ── WHAT THE DELEGATION PRODUCED, READ FROM THE DELEGATION ────────────────────────────────────────
  //
  // Returns what the round should carry, or `undefined` when this round was worked by the agent logging it.
  // Every refusal here is a refusal to record a claim nobody can check.
  private async delegationOf(
    tenant: string,
    campaign: ChangeCampaignRecord,
    input: LogChangeRoundInput,
  ): Promise<{ round: ChangeRoundDelegation; changes: ChangeSetEntry[]; gateRuns: GateRun[] } | undefined> {
    if (input.delegationRunId === undefined) {
      if (campaign.delegation === undefined) return undefined;
      throw new BadRequestError(
        "BAD_REQUEST",
        { campaignId: campaign.id },
        "this campaign's rounds are performed by a delegated work agent, so the round must name the sandbox session that produced its work (delegationRunId) — a hand-typed round under this campaign would say nobody did it.",
      );
    }
    const reader = this.deps.delegations;
    if (reader === undefined)
      throw new BadRequestError(
        "NOT_CONFIGURED",
        { delegationRunId: input.delegationRunId },
        "this deployment cannot read delegate reports, so a round cannot name one.",
      );

    const read = await reader.read(tenant, input.delegationRunId);
    let work: DelegationWork;
    switch (read.kind) {
      case "read":
        work = read.value;
        break;
      case "absent":
        throw new NotFoundError(
          "NOT_FOUND",
          { delegationRunId: input.delegationRunId },
          `delegation session '${input.delegationRunId}' is not a delegation this workspace holds.`,
        );
      // ⚠️ NOT "no report, so log it without one" (protocol L2). A delegation nobody could read is not a
      // delegation that produced nothing, and the round would then claim work whose evidence is unreachable.
      case "unknown":
        throw new ConflictError(
          "CONFLICT",
          { delegationRunId: input.delegationRunId, reason: read.reason },
          `delegation session '${input.delegationRunId}' could not be read, so this round cannot say what the worker did — retry once it is reachable rather than logging a round that names it blindly.`,
        );
      default:
        // The union is closed; an arm added later must be answered HERE rather than falling through to a
        // round that names a delegation nobody classified.
        return assertNever(read);
    }

    // `completed` and `awaiting` are both endings a supervisor can judge — the second stopped on a question,
    // and the round records that it did. Anything else is an outcome nobody has observed yet.
    if (work.status !== "completed" && work.status !== "awaiting")
      throw new ConflictError(
        "CONFLICT",
        { delegationRunId: input.delegationRunId, status: work.status },
        `delegation session '${input.delegationRunId}' is ${work.status} — a round logged now would claim an outcome nobody has observed.`,
      );

    const report = work.report;
    if (report === undefined)
      throw new ConflictError(
        "CONFLICT",
        { delegationRunId: input.delegationRunId, status: work.status },
        `delegation session '${input.delegationRunId}' ended without filing a report, so there is nothing to join to this campaign's criteria — ask it for one, or log the round yourself.`,
      );

    // Does the report answer the brief it was GIVEN? The domain already owns this question; what was missing
    // was a caller. A citation that resolves to nothing, or two verdicts for one criterion, is not evidence a
    // round may be built on — the same law this service already enforces on its own answers.
    const review = reviewDelegateReport(work.brief, report);
    if (review.danglingGateRuns.length > 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { delegationRunId: input.delegationRunId, danglingGateRuns: review.danglingGateRuns },
        "the delegate's report has `observed` answers citing gate runs it does not carry — an observation that names no measurement is an assertion wearing the other word, and the round would file it as evidence.",
      );

    // …and does it answer THIS campaign's declaration? Different id spaces on purpose: a delegate briefed on
    // an older list is exactly the case that has to stay visible.
    const join = joinDelegateReportToCriteria(campaign.criteria, report);
    if (join.duplicated.length > 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { delegationRunId: input.delegationRunId, duplicated: join.duplicated },
        `the delegate answered ${join.duplicated.join(", ")} more than once — two verdicts for one criterion is not a stronger claim, it is no claim.`,
      );

    // The change set is the delegate's. A supervisor retyping the commits is the re-derivation that makes the
    // round a description of the work instead of a record of it.
    if (input.changes.length > 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { delegationRunId: input.delegationRunId },
        "a delegated round takes its change set from the delegate's report — send `changes` only for a round you performed yourself.",
      );
    const reportedGateIds = new Set(report.gateRuns.map((g) => g.id));
    const collision = (input.gateRuns ?? []).find((g) => reportedGateIds.has(g.id));
    if (collision !== undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { delegationRunId: input.delegationRunId, gateRunId: collision.id },
        `gate run '${collision.id}' is already the delegate's measurement — your own verification run needs its own id, or the round would show one number under two authors.`,
      );

    return {
      round: {
        runId: input.delegationRunId,
        summary: report.summary,
        reported: join.reported,
        unknownCriteria: join.unknownCriteria,
        briefedOn: work.brief.doneWhen.map((c) => c.id),
        blockers: report.blockers,
        questions: report.questions.map((q) => q.id),
      },
      changes: report.changes,
      gateRuns: report.gateRuns,
    };
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

// THE LATEST ROUND IS THE CURRENT STANDING, and it is the whole standing: `assertAnswersCoverCriteria` makes
// every round answer every declared criterion, so the newest answer set is a complete picture rather than a
// delta some reader has to fold over the earlier ones. A campaign with no rounds yet has nothing settled —
// which is the truthful reading of "opened, not attempted", not an empty count.
// The row, from the record. `rounds` becomes a count plus the LATEST round's verdict — not an omitted field,
// because a campaign with four rejected attempts and one that has never been attempted must not render alike.
// The latest round is also the current standing (every round answers every criterion), so the digest is a
// complete verdict rather than a delta someone has to fold.
function summarise(record: ChangeCampaignRecord): ChangeCampaignSummary {
  const { rounds, criteria, ...rest } = record;
  const latest = rounds.at(-1);
  return {
    ...rest,
    requirements: summariseRequirements(criteria, latest?.judgement.answers ?? []),
    criteriaCount: criteria.length,
    rounds: {
      total: rounds.length,
      ...(latest !== undefined
        ? {
            latest: {
              seq: latest.seq,
              outcome: latest.outcome,
              at: latest.judgement.at,
              by: latest.judgement.by,
              ...(latest.delegation !== undefined ? { delegationRunId: latest.delegation.runId } : {}),
            },
          }
        : {}),
    },
  };
}

function withRequirements(record: ChangeCampaignRecord): ChangeCampaignView {
  const latest = record.rounds.at(-1);
  return {
    ...record,
    requirements: summariseRequirements(record.criteria, latest?.judgement.answers ?? []),
  };
}

// Exhaustiveness for the ReadResult switch above — a new arm becomes a compile error at the one place that
// decides what an unclassified delegation read means.
function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}
