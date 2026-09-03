import type {
  CampaignFrame,
  CampaignFrameFromIssue,
  CampaignRound,
  CandidateSource,
  DomainFact,
  EvolutionCampaignRecord,
  ReadResult,
  RoundEvidence,
} from "@everdict/contracts";
import {
  type AdoptionOperation,
  BadRequestError,
  CampaignRoundInputSchema,
  ConflictError,
  InternalError,
  NotFoundError,
  RoundEvidenceSchema,
  type Score,
  isJudgeFamilyMetric,
  isMeasured,
} from "@everdict/contracts";
import { campaignFrameDefects } from "@everdict/contracts";
import type { ExperimentIdentity, RoundEvidenceSide, TrialDiff } from "@everdict/domain";
import {
  type CampaignGateAnswer,
  adoptionProofOf,
  campaignAdoption,
  campaignRoundRefusal,
  caseLinksOf,
  contentDigest,
  diagnosesOf,
  frameFromCases,
  oracleTouched,
  roundEvidenceKey,
  roundEvidenceOf,
  seedLeakOf,
} from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type {
  AdoptionOperationStore,
  CampaignEvidenceStore,
  CampaignSubjectRef,
  EvolutionCampaignStore,
  HarnessShapeReader,
  SeedProvenanceReader,
} from "../ports/evolution-campaign-store.js";

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
    // The SUBMIT-time judge pins a real batch carries. Kept as the fallback for a record settled before the
    // scoring ledger existed; the ledger below is the source (see `judgesOf` in `verdictOf`).
    orchestration?: { judges?: Array<{ id: string }> };
    // ── WHO SCORED THE PLANE BEING COMPARED (review of the loop's judge check) ─────────────────────
    //
    // The scoring ledger's CURRENT revision names the judges whose verdicts are in the score plane — stamped
    // by the pass that applied them, on an ingested batch and a dispatched one alike. `orchestration` is a
    // batch-only field (re-drive inputs), so an ingested scorecard never has it: a frame that pinned its
    // judges rejected every ingested round as "judges are not the frame's (none; none)" while the pins sat
    // one field over in `scoring`. Two readers of one fact, one of them reading a field the other kind of
    // record does not carry (rule `protocol` L3).
    scoring?: ReadonlyArray<{ judges: ReadonlyArray<{ id: string }> }>;
    // ── WHAT THE JUDGES SAID ABOUT THIS SIDE'S ACCOUNT OF ITSELF (arch-review 71 P1-evolution) ──────
    //
    // The per-case scores, for the one thing the round verdict cannot derive from a trials comparison: a
    // judge that was shown the platform's observation account and answered whether the trace agrees with it.
    // Without this the field existed on the score, the policy existed on the frame, and nothing joined them
    // — which is the shape this whole review is about, one layer up.
    // `record.scorecard.results` is the per-case `CaseResult[]` the detail read carries — the same rows the
    // analyst sees, so nothing new is fetched and nothing is re-derived from rendering.
    // The side's per-case results: the scores the observation account reads, and the run coordinates the round's
    // evidence record points at (benchmark-evidence-spec.md §3).
    scorecard?: { results: ReadonlyArray<{ scores: Score[]; caseId?: string; runId?: string; trial?: number }> };
    // The digest of the spec that batch actually ran, sealed at submit. This is the join every later
    // adoption proof rests on: a version label cannot tell an evaluated C1 from a saved C2 (arch-review 71
    // P0-evolution).
    // …and WHICH ENVIRONMENT DOCUMENT each referencing case ran against (harness-definability-spec.md §2),
    // which is where an environment campaign's treatment coordinates live: the harness stamp names the
    // harness, so a subject that is not the harness has to be read from the seal.
    manifest?: { harness?: { specDigest?: string }; environments?: Record<string, { ref: string }> };
    // ── WHERE THE BATCH SAYS IT CAME FROM (docs/architecture/code-evolution-loop.md, D4) ──────────
    //
    // The scorecard's trigger provenance: `source` is stamped server-side from the submitter's credential, the
    // coordinates are the client's (for a `github-actions` source, the CI runner's under OIDC). Copied onto
    // the round as `candidateSource` — from THIS record, never from the caller's round input (L3).
    origin?: {
      source: string;
      repo?: string;
      sha?: string;
      ref?: string;
      prNumber?: number;
      runUrl?: string;
      pinOverrides?: Record<string, string>;
    };
  };
}

// The candidate's origin, projected to the fields the round records — and only when the record carries one.
// A batch with no origin is not "from nowhere"; it is a round that cannot say, which the field's absence states.
// The refusal a round meets when Everdict's own build ledger cannot say whether it built the candidate. Named
// so the mutation rung that removes it has one line to neutralize, and typed `never` so the `.catch` it feeds
// cannot quietly become a value.
function unreadableBuildLedger(campaignId: string, candidateVersion: string): (err: unknown) => never {
  return (err: unknown): never => {
    throw new InternalError(
      "UPSTREAM_ERROR",
      { campaignId, candidateVersion, cause: err instanceof Error ? err.message : String(err) },
      `the build ledger could not be read, so whether Everdict built candidate ${candidateVersion} — and from which pull request — cannot be established; the round was not logged, retry once the ledger answers`,
    );
  };
}

// One compared side, in the shape the evidence record reads: the batch id the caller named, the version the
// record itself says it evaluated, and the run coordinates its results carry.
function sideOf(scorecardId: string, side: CampaignComparisonSide): RoundEvidenceSide {
  const results = side.record.scorecard?.results;
  return {
    scorecardId,
    version: side.record.harness.version,
    ...(results !== undefined
      ? {
          results: results.map((r) => ({
            ...(r.caseId !== undefined ? { caseId: r.caseId } : {}),
            ...(r.runId !== undefined ? { runId: r.runId } : {}),
            ...(r.trial !== undefined ? { trial: r.trial } : {}),
            // Diagnoses off the MEASURED judge scores only (evidence spec §2): parsed here, where every other
            // reader already filters `isMeasured`, so the domain builder never touches a raw scores array.
            diagnoses: diagnosesOf(
              r.scores.filter(isMeasured).map((sc) => ({
                metric: sc.metric,
                ...(sc.detail !== undefined ? { detail: sc.detail } : {}),
              })),
            ),
          })),
        }
      : {}),
  };
}

function candidateSourceOf(side: CampaignComparisonSide): CandidateSource | undefined {
  const origin = side.record.origin;
  if (origin === undefined) return undefined;
  return {
    source: origin.source,
    ...(origin.repo !== undefined ? { repo: origin.repo } : {}),
    ...(origin.sha !== undefined ? { sha: origin.sha } : {}),
    ...(origin.ref !== undefined ? { ref: origin.ref } : {}),
    ...(origin.prNumber !== undefined ? { prNumber: origin.prNumber } : {}),
    ...(origin.runUrl !== undefined ? { runUrl: origin.runUrl } : {}),
    ...(origin.pinOverrides !== undefined ? { pinOverrides: origin.pinOverrides } : {}),
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
      // Only a JUDGE can carry an assessment: the observation channel is handed to the judge prompt, and a
      // cost or a step count structurally never answers it. Counting every measured score made the
      // denominator a function of how many trace graders ran beside the judge — ingest always derives three
      // — so one judge per case put the coverage ceiling at 0.25 and a frame demanding 0.5 could never adopt.
      // The family predicate is the contracts' one owner, not a second `startsWith("judge:")`.
      if (!isJudgeFamilyMetric(sc.metric)) continue;
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
  issues: {
    get(
      tenant: string,
      ref: string,
    ): Promise<{
      id: string;
      teamId?: string;
      // The issue's links, for a frame derived `fromIssue` — the `case` links name the exam.
      links?: ReadonlyArray<{ type: string; id: string; version?: string; dataset?: string }>;
    }>;
  };
  // What the candidate's seeds were born from (harness-identity-and-seeds-spec.md §4): a seed whose evidence
  // names a scorecard over the frame's held-out scenarios is the exam mounted into the candidate. REQUIRED.
  seedProvenance: SeedProvenanceReader;
  // The candidate's slots, for attribution on the evidence record (evolution-routing-spec.md §2). REQUIRED.
  shape: HarnessShapeReader;
  // Where a round's evidence record is staged before the round is appended (benchmark-evidence-spec.md §3).
  // REQUIRED: a round without its evidence is a round whose next brief is built from raw reads again.
  evidence: CampaignEvidenceStore;
  // The dataset version a derived frame's scenarios come from. REQUIRED: an optional one would let "no registry
  // wired" read as "no such dataset" at the one door that turns an issue into an exam (rule `protocol`).
  datasets: { get(tenant: string, id: string, ref?: string): Promise<{ cases: ReadonlyArray<{ id: string }> }> };
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
  // ── EVERDICT'S OWN ACCOUNT OF A CANDIDATE IT BUILT (docs/architecture/code-evolution-loop.md, D2) ──
  //
  // When Everdict built the candidate's image itself (a `campaign.candidate_built` record whose
  // `candidateVersion` is the round's candidate), the round's `candidateSource` is filled from THAT — the
  // commit the build observed, the image the registry stored, the base it extended — which outranks a
  // scorecard origin's caller-authored coordinates. Optional: a campaign that pins rather than builds has no
  // build store, and the scorecard origin stands. Richer PROVENANCE, not a decision input — the round still
  // verifies the batch's harness identity against the frame either way.
  builds?: {
    forCampaign(
      tenant: string,
      campaignId: string,
    ): Promise<
      ReadonlyArray<{
        id: string;
        state: string;
        candidateVersion?: string;
        source: { git: string; repo?: string; ref?: string; sha?: string; prNumber?: number };
        image?: { ref: string };
        base: { image: string };
      }>
    >;
    // The build SETS (evolution-routing-spec.md §4): one version minted from several slots.
    setsForCampaign(
      tenant: string,
      campaignId: string,
    ): Promise<
      ReadonlyArray<{
        id: string;
        state: string;
        candidateVersion?: string;
        source: { ref: string; repo?: string; prNumber?: number };
        sha?: string;
        images?: Record<string, string>;
      }>
    >;
  };
  // ── WHAT A CANDIDATE'S PULL REQUEST CHANGED (docs/architecture/code-evolution-loop.md, D3) ────────
  //
  // The read behind the frame's `oracleScope`: the files one pull request touches, from the repository the
  // candidate scorecard's origin names. REQUIRED, not optional — a deployment with no reader answers
  // `unknown` with its reason, and a frame that declared a scope then rejects every round as unverifiable,
  // which is the fail-closed answer (rule `protocol` L2). An optional dep would make "no GitHub App" read as
  // "the change was clean".
  changes: {
    pullRequestFiles(
      tenant: string,
      repository: string,
      pullNumber: number,
    ): Promise<ReadResult<{ paths: string[]; complete: boolean }>>;
  };
  // ── THE DELEGATION SESSION A ROUND NAMES (code-evolution-loop.md, delegation budget) ────────────
  //
  // The sandbox run the frame's `delegation` budget is checked against. Same law as `changes`: required, and
  // a run that cannot be read is a round that cannot be logged under a budgeted frame.
  runs: {
    get(
      id: string,
    ): Promise<{ tenant: string; kind?: string; session?: { ttlSec: number }; usage?: { usd: number } } | undefined>;
  };
  newId?: () => string;
  now?: () => string;
}

// What the oracle check found about one candidate pull request. `undefined` from the caller means the frame
// declared no scope, and the question was never asked.
type SeedLeakCheck = { kind: "clean" } | { kind: "leak"; seeds: string[] } | { kind: "unverifiable"; reason: string };

export type OracleCheck =
  | { kind: "clean" }
  | { kind: "touched"; paths: string[] }
  | { kind: "unverifiable"; reason: string };

export interface NewCampaignInput {
  issueId: string;
  // A full frame, or `{ fromIssue: true, … }` — everything but the exam, which the service derives from the
  // issue's `case` links and the dataset version they pin (evolution-routing-spec.md §3).
  frame: CampaignFrame | CampaignFrameFromIssue;
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
  // What this round taught — carried onto the round and read by the NEXT proposal, never by the gate.
  // Optional on this port because a round written before the field existed has none; the transport's DTO is
  // what requires it of new rounds (see `log-campaign-round.ts`).
  learned?: string;
  // Which OTHER campaigns' findings shaped this proposal (parallel-evolution.md). Advice like `learned`, and
  // provenance for a reader: branches that read each other converge, so a tree of them keeps paying for N
  // walks while asking fewer than N distinct questions. Absent = this campaign's own trace alone.
  informedBy?: string[];
  // The sandbox session that produced the candidate (code-evolution-loop.md, delegation budget). Required by
  // the write when the frame declares a delegation budget; recorded from the run ledger whenever named.
  delegationRunId?: string;
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
    // The exam: the caller's, or derived from the issue's `case` links (evolution-routing-spec.md §3).
    const frame = "fromIssue" in input.frame ? await this.frameFromIssue(tenant, issue, input.frame) : input.frame;
    // …and if this campaign says it CONTINUES another, the claim is verified before anything is written.
    // Open is the only moment the answer can change anything: after it the frame is frozen and its rounds are
    // judged at a level nobody may revise.
    await this.assertChainIsHonest(tenant, frame);
    const record: EvolutionCampaignRecord = {
      id: this.newId(),
      tenant,
      issueId: issue.id,
      ...(issue.teamId !== undefined ? { teamId: issue.teamId } : {}),
      frame,
      frameDigest: contentDigest(frame),
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
        subjectType: frame.subject.type,
        subjectId: frame.subject.id,
        baselineVersion: frame.subject.baselineVersion,
      },
    };
    await this.deps.store.create(record, this.stamped(tenant, [fact]));
    return record;
  }

  // ── THE EXAM IS THE ISSUE'S (docs/architecture/evolution-routing-spec.md §3) ─────────────────────
  //
  // The issue's `case` links name one dataset version and the cases the issue is about; the dataset version
  // names every case there is. Targets are the linked cases, held-out is the rest, and the creation rules are
  // applied to the result exactly as to a hand-written frame. Every way the links fail to be ONE exam is a
  // refusal by name — a campaign whose exam is ambiguous has not frozen anything.
  private async frameFromIssue(
    tenant: string,
    issue: { id: string; links?: ReadonlyArray<{ type: string; id: string; version?: string; dataset?: string }> },
    base: CampaignFrameFromIssue,
  ): Promise<CampaignFrame> {
    const refuse = (message: string): never => {
      throw new BadRequestError("BAD_REQUEST", { issue: issue.id }, message);
    };
    const named = caseLinksOf(issue.links ?? []);
    switch (named.kind) {
      case "none":
        return refuse(
          "the issue links no cases, so no exam can be derived from it — add `case` links (dataset + version + case id), or send a full frame",
        );
      case "several":
        return refuse(
          `the issue links cases from ${named.datasets.length} datasets (${named.datasets.join(", ")}) — one campaign is one exam; open one per dataset, or send a full frame`,
        );
      case "unpinned":
        return refuse(
          `the issue's case links on dataset ${named.dataset} do not all pin a version — a derived frame freezes exactly one dataset version`,
        );
      case "mixed_versions":
        return refuse(
          `the issue's case links pin ${named.versions.length} versions of dataset ${named.dataset} (${named.versions.join(", ")}) — one exam is one version`,
        );
      case "one": {
        const dataset = await this.deps.datasets.get(tenant, named.dataset, named.version); // absent → NotFoundError
        const answer = frameFromCases(
          base,
          dataset.cases.map((c) => c.id),
          named.caseIds,
        );
        if (answer.kind === "refused") return refuse(answer.reason);
        return answer.frame;
      }
      default:
        return assertNever(named);
    }
  }

  // ── THE EVIDENCE A ROUND SEALED, READ BACK AGAINST ITS DIGEST (benchmark-evidence-spec.md §3) ────
  //
  // The round names bytes by key + digest; this serves those bytes and nothing else. A round logged before the
  // record existed says so (404, not an invented record); a key the store does not hold is an escalation — the
  // round references evidence nobody can find; bytes that do not digest to what the round sealed are refused,
  // because serving them would be serving something the round did not seal (L4).
  async roundEvidence(tenant: string, id: string, seq: number): Promise<RoundEvidence> {
    const record = await this.get(tenant, id);
    const round = record.rounds.find((r) => r.seq === seq);
    if (round === undefined)
      throw new NotFoundError("NOT_FOUND", { campaign: id, seq }, `campaign ${id} has no round ${seq}`);
    const ref = round.verdict.evidence;
    if (ref === undefined)
      throw new NotFoundError(
        "NOT_FOUND",
        { campaign: id, seq },
        `round ${seq} carries no evidence record — it was logged before the record existed, and none is invented for it`,
      );
    const document = await this.deps.evidence.get(tenant, ref.key);
    if (document === undefined)
      throw new InternalError(
        "UPSTREAM_ERROR",
        { campaign: id, seq, key: ref.key },
        `round ${seq} references evidence at ${ref.key} and the store holds nothing there — the round's evidence is missing, which is an escalation, not an empty answer`,
      );
    if (contentDigest(document) !== ref.digest)
      throw new ConflictError(
        "CONFLICT",
        { campaign: id, seq, key: ref.key, sealed: ref.digest, held: contentDigest(document) },
        `the evidence stored at ${ref.key} does not digest to what round ${seq} sealed — refusing to serve bytes the round did not seal`,
      );
    return RoundEvidenceSchema.parse(document);
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
    // ── …AND EVERY BRANCH OFF THE CHAIN, NOT ONLY THE LINE ABOVE IT ────────────────────────────────
    //
    // The walk above counts ANCESTORS. A successor that halted adopted nothing, so nobody can continue it —
    // the natural next move is a second successor of the same adopted predecessor, and that one read `spent`
    // as the predecessor's rounds alone. Every round the halted sibling logged consulted the same held-out
    // rows (its frame passed the same-exam check to open at all), and the family forgot them.
    //
    // So the population is the whole tree the chain's members root: every campaign whose `continues` names a
    // member, transitively. Read across the tenant WITHOUT the caller's team ceiling on purpose — a private
    // team's sibling spent the rows just the same, and only a count leaves this function.
    const everyCampaign = await this.deps.store.list(tenant);
    const tree = new Set(seen);
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of everyCampaign) {
        const from = c.frame.continues;
        if (from !== undefined && tree.has(from) && !tree.has(c.id)) {
          tree.add(c.id);
          grew = true;
        }
      }
    }
    for (const c of everyCampaign) if (tree.has(c.id) && !seen.has(c.id)) spent += c.rounds.length;

    // 1. It continues a RESULT. A campaign that halted proved nothing to carry forward, and one still open
    //    has not finished spending its own share of the family.
    const outcome = parent.close?.outcome;
    if (outcome === undefined || outcome.kind !== "adopted")
      throw new ConflictError(
        "CONFLICT",
        { continues: parent.id, state: parent.state },
        `campaign '${parent.id}' adopted nothing, so there is no version to continue from — a chain continues a result, not an attempt`,
      );
    // 1b. …and the CODE that result was built from is on the default branch (code-evolution-loop.md, D5). An
    //     adoption whose pull request is still a branch has registered bytes the next campaign's baseline image
    //     will carry while the repository's default branch does not — a successor opened over that starts from
    //     bytes whose source nobody can check out. Absence of a debt means the candidate named no pull request,
    //     which is the honest "nothing owed", not a merge.
    const parentOperation = await this.deps.operations.forCampaign(tenant, parent.id);
    if (parentOperation?.code !== undefined && parentOperation.code.state !== "merged")
      throw new ConflictError(
        "CONFLICT",
        { continues: parent.id, repo: parentOperation.code.repo, prNumber: parentOperation.code.prNumber },
        `campaign '${parent.id}' adopted code that is not merged — pull request #${parentOperation.code.prNumber} of ${parentOperation.code.repo} is still a branch. Merge it through the campaign (POST /campaigns/${parent.id}/merge) and open the successor again; a chain starts from what is on the default branch`,
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

  // `subject` = one capability's whole evolution memory (evolution-routing-spec.md §5): every campaign ever
  // opened on it, each with its rounds — verdicts, evidence references, `learned` — and its close. The brief for
  // a new campaign reads this so the same dead hypothesis is not spent twice.
  async list(
    tenant: string,
    visibleTeams?: string[],
    subject?: CampaignSubjectRef,
  ): Promise<EvolutionCampaignRecord[]> {
    return this.deps.store.list(tenant, visibleTeams, subject);
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
    // ── WHAT IS WRITTEN IS WHAT CAN BE READ BACK ───────────────────────────────────────────────────
    //
    // The row is decoded through `EvolutionCampaignRecordSchema` on every Postgres read — `get` and, row by
    // row, `list` — so a caller-authored field the record schema refuses is a campaign nobody can read and a
    // workspace list that 500s. The HTTP DTO bounded these fields; the MCP twin did not; and this service
    // appended the literal unparsed. The bounds are the record's own projection (`CampaignRoundInputSchema`),
    // checked HERE so every door inherits them, and remapped to our error model (rule `typescript`).
    const bounded = CampaignRoundInputSchema.safeParse(input);
    if (!bounded.success)
      throw new BadRequestError(
        "BAD_REQUEST",
        { issues: bounded.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
        `the round cannot be stored as sent: ${bounded.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      );
    // ── …AND A ROUND PAST THE FRAME'S OWN ENDING IS REFUSED, NOT SCORED ───────────────────────────
    //
    // The budget and the rejected streak were answered by `decision` and enforced by nobody: a driver that
    // never asked, or ignored a halt, could log past either until a round happened to win — and the gate,
    // reading the latest round first, adopted it at a level the pre-registered family never covered. The
    // predicate is the domain's (`campaignRoundRefusal`, the same owner the gate reads), and the refusal is
    // race-safe because `appendRound` CASes on the round count this answer was computed over: two writers at
    // the last budgeted slot cannot both land.
    const ended = campaignRoundRefusal(record.frame, record.rounds);
    if (ended !== undefined)
      throw new ConflictError(
        "CONFLICT",
        {
          campaign: id,
          reason: ended.reason,
          atRound: ended.atRound,
          rounds: record.rounds.length,
          budget: record.frame.budget.maxRounds,
        },
        ended.detail,
      );
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
    const refuse = (what: string, extra: Record<string, unknown>): never => {
      throw new BadRequestError("BAD_REQUEST", extra, what);
    };
    const baselineHarness = snapshot.baseline.record.harness;
    const candidateHarness = snapshot.candidate.record.harness;
    // ── AN ENVIRONMENT SUBJECT IS VERIFIED AGAINST THE SEAL, NOT THE HARNESS STAMP (§2) ────────────
    //
    // For an agent or a harness subject the scorecard's own harness stamp names the treatment, which is what
    // the block below reads. An environment campaign inverts that: the harness is the HELD CONSTANT and the
    // environment is what moved, so the coordinates live in each side's manifest seal — and the harness
    // being equal is a check nothing else performs, because identity deliberately excludes the harness axis
    // (it is normally the treatment).
    if (record.frame.subject.type === "environment") {
      const subjectId = record.frame.subject.id;
      const pinned = (side: "baseline" | "candidate"): string => {
        const sealed = snapshot[side].record.manifest?.environments;
        const refs = new Set(Object.values(sealed ?? {}).map((e) => e.ref));
        const mine = [...refs].filter((r) => r.startsWith(`${subjectId}@`));
        if (mine.length === 0)
          refuse(`the ${side} scorecard sealed no version of environment '${subjectId}' — it did not run it`, {
            side,
            sealed: [...refs],
          });
        if (mine.length > 1)
          refuse(`the ${side} scorecard ran ${mine.length} versions of environment '${subjectId}' at once`, {
            side,
            refs: mine,
          });
        // `mine[0]` exists: the two refusals above cover empty and many, and both throw.
        return (mine[0] ?? "").slice(subjectId.length + 1);
      };
      const baselineEnv = pinned("baseline");
      const candidateEnv = pinned("candidate");
      if (candidateEnv !== input.candidateVersion)
        refuse(
          `the candidate scorecard ran ${subjectId}@${candidateEnv}, not the declared candidate ${input.candidateVersion}`,
          { declared: input.candidateVersion, actual: candidateEnv },
        );
      if (baselineEnv !== record.frame.subject.baselineVersion)
        refuse(
          `the baseline scorecard ran ${subjectId}@${baselineEnv}, not the frame's baseline ${record.frame.subject.baselineVersion}`,
          { frame: record.frame.subject.baselineVersion, actual: baselineEnv },
        );
      if (baselineHarness.id !== candidateHarness.id || baselineHarness.version !== candidateHarness.version)
        refuse(
          `an environment campaign holds the harness constant and the sides ran ${baselineHarness.id}@${baselineHarness.version} vs ${candidateHarness.id}@${candidateHarness.version}`,
          { baseline: baselineHarness, candidate: candidateHarness },
        );
    }
    const expectedId =
      record.frame.subject.type === "harness" ? record.frame.subject.id : `agent:${record.frame.subject.id}`;
    if (
      record.frame.subject.type !== "environment" &&
      (candidateHarness.id !== expectedId || baselineHarness.id !== expectedId)
    )
      refuse(
        `the compared scorecards evaluated '${baselineHarness.id}'/'${candidateHarness.id}', not the campaign's subject '${expectedId}'`,
        { expectedId, baseline: baselineHarness, candidate: candidateHarness },
      );
    if (record.frame.subject.type !== "environment" && candidateHarness.version !== input.candidateVersion)
      refuse(
        `the candidate scorecard evaluated ${expectedId}@${candidateHarness.version}, not the declared candidate ${input.candidateVersion}`,
        { declared: input.candidateVersion, actual: candidateHarness.version },
      );
    if (record.frame.subject.type !== "environment" && baselineHarness.version !== record.frame.subject.baselineVersion)
      refuse(
        `the baseline scorecard evaluated ${expectedId}@${baselineHarness.version}, not the frame's baseline ${record.frame.subject.baselineVersion}`,
        { frame: record.frame.subject.baselineVersion, actual: baselineHarness.version },
      );
    // Everdict's own account of the candidate, when it BUILT it (D2): the `built` record whose minted version
    // is this round's candidate. Its coordinates outrank the scorecard origin's — for the verdict AND for the
    // oracle read below, which is why it is read first. The first version read it after the oracle, so a
    // candidate Everdict built from pull request #7 was checked against the scorecard's origin, which a
    // driver-submitted batch does not carry: every oracle-scoped round of the first-party loop was
    // "unverifiable", and the loop this design exists for could not adopt with an oracle at all.
    const builtSource = await this.builtSourceFor(tenant, id, input.candidateVersion);
    // The oracle boundary, read AFTER the identity checks and BEFORE the verdict: a frame that froze a scope
    // asks what the candidate's pull request changed — the pull request Everdict's build record names, else
    // the one the scorecard's origin names.
    const oracle = await this.oracleCheck(tenant, record.frame, snapshot, builtSource);
    // …and whether the candidate was SEEDED with the exam (harness-identity-and-seeds-spec.md §4) — the same
    // door, the same treatment as a candidate that edited the dataset.
    const seedLeak = await this.seedLeakCheck(tenant, record.frame, input.candidateVersion);
    // …and the delegation the round names, read off the run ledger and held to the frame's budget.
    const delegation = await this.delegationOf(tenant, record.frame, input.delegationRunId);
    const seq = record.rounds.length + 1;
    const at = this.now();
    const verdict = verdictOf(snapshot, record.frame, oracle, builtSource, seedLeak);
    // ── THE ROUND'S EVIDENCE IS STAGED BEFORE THE ROUND EXISTS (benchmark-evidence-spec.md §3) ──────
    //
    // Derived from what this method already read — the diff's per-case trials, the frame's flags, each side's
    // run coordinates — and written as an immutable object the round then names by key + digest (L4). The
    // order is the protocol: bytes first, then the row that references them; a put that fails refuses the
    // round, because a round whose evidence does not exist is the state this record exists to abolish.
    // The candidate's shape, for attribution (routing spec §2) — a harness subject only; an unreadable shape is
    // recorded as the reason every non-improved case is unattributed, never as a refused round.
    const shape =
      record.frame.subject.type === "harness"
        ? await this.deps.shape.slotsOf(tenant, { id: record.frame.subject.id, version: input.candidateVersion })
        : undefined;
    const evidenceDocument = roundEvidenceOf({
      campaignId: id,
      seq,
      frameDigest: record.frameDigest,
      frame: record.frame,
      ...(shape?.kind === "read" ? { slots: shape.value } : {}),
      ...(shape !== undefined && shape.kind !== "read"
        ? { slotsUnreadable: shape.kind === "unknown" ? shape.reason : "the candidate version is not registered" }
        : {}),
      ...(shape === undefined ? { slotsUnreadable: "an agent subject has no slots" } : {}),
      baseline: sideOf(input.baselineScorecardId, snapshot.baseline),
      candidate: sideOf(input.candidateScorecardId, snapshot.candidate),
      ...(snapshot.diff.trials !== undefined ? { trials: snapshot.diff.trials } : {}),
      verdict: {
        comparable: verdict.comparable,
        significantImprovements: verdict.significantImprovements,
        significantRegressions: verdict.significantRegressions,
        ...(verdict.heldOut !== undefined ? { heldOut: verdict.heldOut } : {}),
        ...(verdict.targets !== undefined ? { targets: verdict.targets } : {}),
        ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
      },
      at,
    });
    const evidenceDigest = contentDigest(evidenceDocument);
    const evidenceKey = roundEvidenceKey(id, seq, evidenceDigest);
    await this.deps.evidence.put(tenant, evidenceKey, evidenceDocument); // a failure propagates: no round
    const round: CampaignRound = {
      seq,
      hypothesis: input.hypothesis,
      candidateVersion: input.candidateVersion,
      baselineScorecardId: input.baselineScorecardId,
      candidateScorecardId: input.candidateScorecardId,
      // Recorded BEFORE the verdict is derived, and recorded whatever the verdict turns out to be — a round
      // the platform judges incomparable keeps its lesson, which is the case the layer exists for.
      ...(input.learned !== undefined ? { learned: input.learned } : {}),
      // …and whose findings shaped it. Carried from the input rather than derived: only the driver knows what
      // it read, and a platform guessing at that would be inventing the provenance the field exists to record
      // (rule `protocol` L3). Absent = proposed from this campaign's own trace, which is every round before
      // the field existed.
      informedBy: input.informedBy ?? [],
      ...(delegation !== undefined ? { delegation } : {}),
      verdict: { ...verdict, evidence: { key: evidenceKey, digest: evidenceDigest } },
      at,
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

  // ── EVERDICT'S OWN ACCOUNT OF A CANDIDATE IT BUILT (docs/architecture/code-evolution-loop.md, D2) ──
  //
  // The `built` build record whose minted version is this round's candidate, projected to the round's source
  // fields. `source: "everdict-build"` says these coordinates are Everdict's own — the commit the session
  // observed, the image the registry stored. `undefined` when no build store is wired, or no build produced
  // this version: the scorecard origin then stands.
  private async builtSourceFor(
    tenant: string,
    campaignId: string,
    candidateVersion: string,
  ): Promise<CandidateSource | undefined> {
    if (this.deps.builds === undefined) return undefined;
    // A build SET that minted this version outranks a single build (its members carry no version of their own).
    const sets = await this.deps.builds
      .setsForCampaign(tenant, campaignId)
      .catch(unreadableBuildLedger(campaignId, candidateVersion));
    const set = sets.find((s) => s.state === "minted" && s.candidateVersion === candidateVersion);
    if (set !== undefined)
      return {
        source: "everdict-build",
        ...(set.source.repo !== undefined ? { repo: set.source.repo } : {}),
        ...(set.sha !== undefined ? { sha: set.sha } : {}),
        ref: set.source.ref,
        ...(set.source.prNumber !== undefined ? { prNumber: set.source.prNumber } : {}),
        ...(set.images !== undefined ? { images: set.images } : {}),
        buildSetId: set.id,
      };
    // A ledger that could not be read is not a ledger with no build in it. The first version swallowed the
    // failure into `[]`, so an outage of the build store silently demoted the round's provenance to the
    // caller's coordinates — and, once the oracle read this too, silently made an Everdict-built candidate
    // "unverifiable". The round is refused instead, and nothing is logged (rule `protocol` L2).
    const builds = await this.deps.builds
      .forCampaign(tenant, campaignId)
      .catch(unreadableBuildLedger(campaignId, candidateVersion));
    const built = builds.find((b) => b.state === "built" && b.candidateVersion === candidateVersion);
    if (built === undefined) return undefined;
    return {
      source: "everdict-build",
      ...(built.source.repo !== undefined ? { repo: built.source.repo } : {}),
      ...(built.source.sha !== undefined ? { sha: built.source.sha } : {}),
      ...(built.source.ref !== undefined ? { ref: built.source.ref } : {}),
      ...(built.source.prNumber !== undefined ? { prNumber: built.source.prNumber } : {}),
      ...(built.image?.ref !== undefined ? { image: built.image.ref } : {}),
      baseImage: built.base.image,
      buildId: built.id,
    };
  }

  // ── WAS THE CANDIDATE SEEDED WITH ITS OWN EXAM (harness-identity-and-seeds-spec.md §4) ──────────
  //
  // Only a harness subject ships seeds. Three answers, never two: clean, leak (with the seeds), or unverifiable
  // — the candidate's seeds could not be read, or their provenance could not. "Could not check" is not "clean".
  private async seedLeakCheck(tenant: string, frame: CampaignFrame, candidateVersion: string): Promise<SeedLeakCheck> {
    if (frame.subject.type !== "harness") return { kind: "clean" };
    const seeds = await this.deps.seedProvenance.seedsOf(tenant, { id: frame.subject.id, version: candidateVersion });
    switch (seeds.kind) {
      case "unknown":
        return { kind: "unverifiable", reason: `the candidate's seeds could not be read: ${seeds.reason}` };
      case "absent":
        return {
          kind: "unverifiable",
          reason: `candidate ${frame.subject.id}@${candidateVersion} is not registered, so its seeds cannot be read`,
        };
      case "read": {
        const declared = seeds.value;
        if (declared === undefined || (declared.skills.length === 0 && declared.knowledge.length === 0))
          return { kind: "clean" };
        const evidence = await this.deps.seedProvenance.evidenceOf(tenant, declared);
        if (evidence.kind !== "read")
          return {
            kind: "unverifiable",
            reason: `the candidate's seeds' provenance could not be read: ${evidence.kind === "unknown" ? evidence.reason : "absent"}`,
          };
        const heldOut = new Set(frame.scenarios.filter((sc) => sc.heldOut).map((sc) => sc.id));
        const leaking = seedLeakOf(evidence.value, heldOut);
        return leaking.length > 0 ? { kind: "leak", seeds: leaking } : { kind: "clean" };
      }
      default:
        return assertNever(seeds);
    }
  }

  // ── DID THE CANDIDATE TOUCH ITS OWN EXAM (docs/architecture/code-evolution-loop.md, D3) ─────────
  //
  // Answered from the pull request the candidate names — Everdict's own build record first (D2: the commit it
  // observed and the pull request it was asked to build), the candidate scorecard's origin second — and the
  // repository's own listing of what that pull request changed. Three answers, never two: clean, touched
  // (with the paths), or unverifiable — a candidate that names no pull request on either account, a listing
  // the reader could not complete, or a read that failed. The last is refused rather than waved through: "we
  // could not check" is not "clean" (L2).
  private async oracleCheck(
    tenant: string,
    frame: CampaignFrame,
    snapshot: CampaignSnapshot,
    builtSource: CandidateSource | undefined,
  ): Promise<OracleCheck | undefined> {
    if (frame.oracleScope.length === 0) return undefined;
    const source = builtSource ?? candidateSourceOf(snapshot.candidate);
    if (source?.repo === undefined || source.prNumber === undefined)
      return {
        kind: "unverifiable",
        reason:
          "the candidate names no pull request — neither Everdict's build record nor the scorecard's origin (origin.repo / origin.prNumber) carries one — so what the candidate changed cannot be read against the frame's oracle scope",
      };
    const read = await this.deps.changes.pullRequestFiles(tenant, source.repo, source.prNumber);
    switch (read.kind) {
      case "read": {
        if (!read.value.complete)
          return {
            kind: "unverifiable",
            reason: `pull request #${source.prNumber} of ${source.repo} changes more files than could be listed, so the oracle scope cannot be checked against the whole change`,
          };
        const touched = oracleTouched(read.value.paths, frame.oracleScope);
        return touched.length > 0 ? { kind: "touched", paths: touched } : { kind: "clean" };
      }
      case "absent":
        return {
          kind: "unverifiable",
          reason: `pull request #${source.prNumber} was not found in ${source.repo}`,
        };
      case "unknown":
        return { kind: "unverifiable", reason: read.reason };
      default:
        return assertNever(read);
    }
  }

  // ── WHAT THE DELEGATE COST, AS THE LEDGER SAYS (code-evolution-loop.md, delegation budget) ───────
  //
  // A frame that budgets the delegation requires every round to name the sandbox session that produced its
  // candidate, and the round is refused — not scored — when that session ran past the budget: the TTL the
  // ledger granted it, or the spend the ledger metered. Both are read from the RUN, never from the caller's
  // input (L3), and a session that cannot be read is a round that cannot be logged under such a frame (L2).
  // Without a budget the session is still recorded when named, so the trace says who wrote the candidate.
  private async delegationOf(
    tenant: string,
    frame: CampaignFrame,
    runId: string | undefined,
  ): Promise<CampaignRound["delegation"]> {
    const budget = frame.delegation;
    if (runId === undefined) {
      if (budget === undefined) return undefined;
      throw new BadRequestError(
        "BAD_REQUEST",
        { budget },
        "this campaign's frame budgets the delegation, so the round must name the sandbox session that produced its candidate (delegationRunId)",
      );
    }
    const run = await this.deps.runs.get(runId);
    if (run === undefined || run.tenant !== tenant)
      throw new NotFoundError("NOT_FOUND", { runId }, `delegation session '${runId}' not found`);
    if (run.kind !== "sandbox")
      throw new BadRequestError(
        "BAD_REQUEST",
        { runId, kind: run.kind ?? "eval" },
        `run '${runId}' is not a sandbox session — a delegation is a session run, not a case`,
      );
    const ttlSec = run.session?.ttlSec;
    const usd = run.usage?.usd;
    if (budget !== undefined) {
      if (ttlSec === undefined)
        throw new ConflictError(
          "CONFLICT",
          { runId },
          `delegation session '${runId}' records no TTL, so the frame's delegation budget cannot be checked against it`,
        );
      if (ttlSec > budget.ttlSec)
        throw new ConflictError(
          "CONFLICT",
          { runId, ttlSec, budget: budget.ttlSec },
          `delegation session '${runId}' was granted ${ttlSec}s and the frame budgets ${budget.ttlSec}s per round — the round is refused; open the next session within the budget`,
        );
      if (budget.maxUsd !== undefined && usd !== undefined && usd > budget.maxUsd)
        throw new ConflictError(
          "CONFLICT",
          { runId, usd, budget: budget.maxUsd },
          `delegation session '${runId}' spent $${usd.toFixed(4)} and the frame budgets $${budget.maxUsd} per round — the round is refused`,
        );
    }
    return { runId, ...(ttlSec !== undefined ? { ttlSec } : {}), ...(usd !== undefined ? { usd } : {}) };
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
    // ── …AND THE CODE THE CLOSE OWES (docs/architecture/code-evolution-loop.md, D5) ─────────────────
    //
    // When the proved bytes were built from a pull request, the registry write is half the adoption: the code
    // is still a branch until it is merged, and the next campaign's baseline and the default branch diverge
    // until then. Born here, from the PROOF's own source coordinates — never from the caller — as an owed
    // sub-lifecycle the merge effect pays and the chain check reads.
    const source = proof?.candidateSource;
    const code =
      source?.repo !== undefined && source.prNumber !== undefined
        ? {
            repo: source.repo,
            prNumber: source.prNumber,
            ...(source.sha !== undefined ? { sha: source.sha } : {}),
            state: "owed" as const,
          }
        : undefined;
    const adoption: AdoptionOperation | undefined =
      proof === undefined
        ? undefined
        : {
            operationId: `adopt/${record.tenant}/${record.id}`,
            tenant: record.tenant,
            proof,
            state: "decided",
            ...(code !== undefined ? { code } : {}),
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
          // …and the commit / pull request they were built from, so the close names what a merge is about (D4).
          ...(answer.candidateSource !== undefined ? { candidateSource: answer.candidateSource } : {}),
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
        // The adopted candidate's source coordinates, for the feed and for a subscription that wants to merge
        // the pull request an adoption proved (docs/architecture/code-evolution-loop.md, D5).
        ...(answer.kind === "adopt" && answer.candidateSource?.repo !== undefined
          ? { candidateRepo: answer.candidateSource.repo }
          : {}),
        ...(answer.kind === "adopt" && answer.candidateSource?.sha !== undefined
          ? { candidateSha: answer.candidateSource.sha }
          : {}),
        ...(answer.kind === "adopt" && answer.candidateSource?.prNumber !== undefined
          ? { candidatePrNumber: answer.candidateSource.prNumber }
          : {}),
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
function verdictOf(
  snapshot: CampaignSnapshot,
  frame: CampaignFrame,
  oracle: OracleCheck | undefined,
  builtSource: CandidateSource | undefined,
  seedLeak: SeedLeakCheck,
): CampaignRound["verdict"] {
  const comparison = snapshot.diff;
  // Identity coverage first: an absent identity read is NOT "verified" (L2) — it blocks like an unverified
  // axis until the diff can say what it compared.
  const unverifiedAxes =
    comparison.experiment === undefined
      ? ["experiment_identity_unavailable"]
      : comparison.experiment.unverified.map((u) => u.axis);
  // Axes VERIFIED different — stronger than unverified, never waivable: a delta across different worlds is
  // not evidence about the change under test (the axis's own sentence).
  // …minus the axis this campaign IS. A harness campaign has no such subtraction to make — identity never
  // reads the harness, precisely because it is the treatment — and an environment campaign needs the same
  // exemption spelled out: the environment axis reporting a verified difference is the experiment happening,
  // not a confound. The harness staying equal is checked separately, where the round's identity is verified.
  const treatmentAxis = frame.subject.type === "environment" ? "environment" : undefined;
  const confoundedAxes =
    comparison.experiment === undefined
      ? []
      : comparison.experiment.confounds.map((c) => c.axis).filter((axis) => axis !== treatmentAxis);
  // Where the candidate came from rides EVERY verdict, rejected ones included: a round the platform could not
  // compare still names the pull request that produced its candidate, which is what the next brief reads.
  // Everdict's OWN build account (D2) outranks the scorecard origin whenever it built the candidate.
  const candidateSource = builtSource ?? candidateSourceOf(snapshot.candidate);
  const rejected = (detail: string): CampaignRound["verdict"] => ({
    comparable: false,
    significantImprovements: 0,
    significantRegressions: 0,
    unverifiedAxes,
    confoundedAxes,
    ...(candidateSource !== undefined ? { candidateSource } : {}),
    detail,
  });
  if (comparison.comparability === "none")
    return rejected("the pair is not comparable (verdict-policy mismatch or an unresolvable stamp)");
  if (confoundedAxes.length > 0)
    return rejected(`the comparison is confounded — ${confoundedAxes.join(", ")} verifiably differ between the sides`);
  // THE EXAM WAS MOUNTED INTO THE CANDIDATE (harness-identity-and-seeds-spec.md §4): a seed born from the
  // frame's held-out scenarios is the findings handed to the thing being measured.
  if (seedLeak.kind === "leak")
    return {
      ...rejected(
        `the candidate was seeded with the exam's findings — ${seedLeak.seeds.join(", ")} carry evidence over the frame's held-out scenarios`,
      ),
      seedLeak: seedLeak.seeds,
    };
  if (seedLeak.kind === "unverifiable")
    return rejected(
      `the candidate's seeds could not be checked against the frame's held-out scenarios: ${seedLeak.reason}`,
    );
  // THE EXAM MOVED (D3): a candidate whose pull request touched the frame's oracle paths is not a candidate,
  // whatever it scored — the same refusal a drifted scenario set gets, applied to the exam's source. The paths
  // ride the verdict so the next brief can name what must not be touched again.
  if (oracle?.kind === "touched")
    return {
      ...rejected(`the candidate touched the oracle — ${oracle.paths.join(", ")} fall inside the frame's oracle scope`),
      oracleTouched: oracle.paths,
    };
  if (oracle?.kind === "unverifiable")
    return rejected(
      `the frame declares an oracle scope and the candidate's change could not be checked against it: ${oracle.reason}`,
    );
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
    // Who SCORED the plane, read from the scoring ledger's current revision — the pass that applied the judges
    // stamped them there, on an ingested batch and a dispatched one alike. `orchestration.judges` is the
    // batch-only submit pin and stays as the fallback for a record settled before the ledger existed; reading
    // it FIRST is what rejected every ingested round under a frame that pinned its judges.
    const judgesOf = (side: CampaignComparisonSide): string =>
      (side.record.scoring?.at(-1)?.judges ?? side.record.orchestration?.judges ?? [])
        .map((j) => j.id)
        .sort()
        .join(",");
    if (judgesOf(snapshot.baseline) !== want || judgesOf(snapshot.candidate) !== want)
      return rejected(
        `the judges are not the frame's (frame: ${want || "none"}; baseline: ${judgesOf(snapshot.baseline) || "none"}; candidate: ${judgesOf(snapshot.candidate) || "none"})`,
      );
  }
  // ── A ROUND THAT COMPARED THE SUBJECT WITH ITSELF IS NOT A ROUND ─────────────────────────────────
  //
  // The verdict already records the candidate's exact bytes (`candidateSpecDigest`) because "a version label
  // cannot tell an evaluated C1 from a saved C2". The same sentence says a label cannot tell a real candidate
  // from a relabelled baseline — and a dropped override does exactly that (`instanceOverrideDefects` refuses
  // the commonest way to author one, and cannot see a candidate that is identical for any other reason).
  //
  // Left comparable, such a round is the worst-shaped evidence this record can hold: it reads 0 improvements
  // and 0 regressions, which the driver is told to treat as a NEUTRAL result and build on. It spends a slot of
  // the pre-registered `heldOutFamilySize`, counts toward `stopAfterRejectedRounds`, and its `learned` says
  // the direction is neutral. The direction was never tried.
  //
  // ⚠️ Scoped to a HARNESS subject on purpose. An ENVIRONMENT campaign REQUIRES the harness to be identical on
  // both sides — that is what isolates the world as the treatment — so the same equality is the precondition
  // there rather than the defect.
  const baselineSpecDigest = snapshot.baseline.record.manifest?.harness?.specDigest;
  const candidateSpecDigest = snapshot.candidate.record.manifest?.harness?.specDigest;
  if (
    frame.subject.type === "harness" &&
    baselineSpecDigest !== undefined &&
    baselineSpecDigest === candidateSpecDigest
  )
    return rejected(
      `both sides ran the same harness bytes (${baselineSpecDigest}) — the candidate is the baseline under another label, so this round has no treatment to measure`,
    );
  const significant = comparison.trials.cases.filter((c) => c.significant);
  // ── …AND THE HELD-OUT POPULATION, COUNTED APART (arch-review 71 P1-high) ──────────────────────────
  //
  // The whole-round counts are the loop's own feedback: it has been optimizing against the training
  // scenarios, so improving there is evidence about the SEARCH, not about the capability. Adoption
  // authority reads the held-out block (`campaignAdoption`), and this is where the frame's annotation
  // finally decides something.
  const heldOutIds = new Set(frame.scenarios.filter((sc) => sc.heldOut).map((sc) => sc.id));
  const heldOutCases = significant.filter((c) => heldOutIds.has(c.caseId));
  // …and the frame's TARGETS, one by one (evolution-routing-spec.md §3): a target flipped when it improved
  // significantly on the candidate. Derived here, from the same significance the held-out block reads, so the
  // gate's "did the issue's cases pass" is the platform's answer and not the driver's.
  const improved = new Set(significant.filter((c) => c.delta > 0).map((c) => c.caseId));
  const targets =
    frame.targets.length > 0
      ? {
          flipped: frame.targets.filter((id) => improved.has(id)),
          unflipped: frame.targets.filter((id) => !improved.has(id)),
        }
      : undefined;
  return {
    comparable: true,
    significantImprovements: significant.filter((c) => c.delta > 0).length,
    significantRegressions: significant.filter((c) => c.delta < 0).length,
    heldOut: {
      improvements: heldOutCases.filter((c) => c.delta > 0).length,
      regressions: heldOutCases.filter((c) => c.delta < 0).length,
    },
    ...(targets !== undefined ? { targets } : {}),
    // …and the exact bytes evaluated, so an adopted label can be checked against what a registry holds
    // under it (arch-review 71 P0-evolution).
    ...(candidateSpecDigest !== undefined ? { candidateSpecDigest } : {}),
    // …and where those bytes were built from (docs/architecture/code-evolution-loop.md, D4).
    ...(candidateSource !== undefined ? { candidateSource } : {}),
    // …and the candidate's own judges on whether its account holds up (arch-review 71 P1-evolution).
    ...(observationsOf(snapshot.candidate) !== undefined ? { observations: observationsOf(snapshot.candidate) } : {}),
    unverifiedAxes,
    confoundedAxes,
  };
}

function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}
