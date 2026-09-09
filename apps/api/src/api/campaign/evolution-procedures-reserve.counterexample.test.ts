import { CampaignService, type CampaignSnapshot, ScorecardService } from "@everdict/application-control";
import type { CampaignFrame, CaseResult, TraceEvent } from "@everdict/contracts";
import { NotFoundError, readUnknown } from "@everdict/contracts";
import { InMemoryCampaignEvidenceStore, InMemoryEvolutionCampaignStore, InMemoryScorecardStore } from "@everdict/db";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";

// ── REVIEW 2026-09-09 R3: a supported procedure could not satisfy the reservation contract ──────────
//
// `logRound` requires every round to own an unreported reservation binding BOTH scorecard ids, and only
// `POST /scorecards` could make one. The first-party `agent_evolve` procedure runs `try_agent` and uploads its
// traces through `ingest_scorecard`, then calls `log_campaign_round` — so the loop the contract exists for
// could not produce an acceptable pair through any sequence of the doors it was given. Its identity waivers
// (`allowUnverifiedIdentity`, `allowLabelOnlyAdoption`) waive unverified axes and label-only adoption, which
// is a different question from whether the comparison was reserved.
//
// Driven through the PRODUCTION services — a real `ScorecardService` wired to a real campaign ledger, and the
// real `CampaignService` rather than the fixture subclass that reserves completed results at settlement time,
// which is what the review's closure test asks for. Only the diff predicate is stubbed: what this case is
// about is whether the ingest lane can produce a reservable pair, not what the comparison then says.
//
// Seen RED before the repair with: "round requires an unreported evaluation reserved before both scorecards
// were submitted" — the ingest door had no `campaignEvaluation` to send.

const frame: CampaignFrame = {
  subject: { type: "agent", id: "everdict", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "c1", heldOut: true },
    { id: "c2", heldOut: true },
  ],
  judges: [],
  trialsPerCase: 2,
  budget: { maxRounds: 3 },
  stopAfterRejectedRounds: 3,
  significance: { fdrAlpha: 0.05, heldOutFamilySize: 3 },
  // The two waivers the shadow-try loop declares at open. They are here precisely so this case proves they
  // are NOT what the reservation refusal was about.
  allowUnverifiedIdentity: true,
  allowLabelOnlyAdoption: true,
  oracleScope: [],
  targets: [],
  observationPolicy: { allowDivergent: false },
};

const trialCase = (caseId: string, delta: number, significant: boolean) => ({
  caseId,
  baselineRate: 0.2,
  baselineTrials: 2,
  candidateRate: 0.2 + delta,
  candidateTrials: 2,
  delta,
  z: 2,
  method: "fisher" as const,
  p: 0.01,
  significant,
});
const snapshot: CampaignSnapshot = {
  diff: {
    comparability: "full",
    trials: {
      baseline: "b",
      candidate: "c",
      zThreshold: 1.96,
      minDelta: 0,
      cases: [trialCase("c1", 0.8, true), trialCase("c2", 0, false)],
    } as CampaignSnapshot["diff"]["trials"],
    // An ingested batch seals no manifest, so every axis reads unverified — which is why this frame declares
    // the waiver. The literal is typed rather than cast: the vocabulary is closed and a typo must not compile.
    experiment: {
      held: [],
      confounds: [],
      unverified: [{ axis: "execution_world" as const, reason: "unsealed" as const, detail: "an ingested batch" }],
    },
  },
  baseline: { record: { harness: { id: "agent:everdict", version: "1.0.0" } } },
  candidate: { record: { harness: { id: "agent:everdict", version: "1.0.1" } } },
};

const traceOf = (caseId: string): { caseId: string; trace: TraceEvent[] } => ({
  caseId,
  trace: [{ t: 0, kind: "message", role: "assistant", text: `answered ${caseId}` }],
});

// The agent procedure's own upload shape: one `traces[]` entry per try, `caseId` the scenario id, repeated
// caseIds ARE the trials.
const shadowTries = [traceOf("c1"), traceOf("c1"), traceOf("c2"), traceOf("c2")];

const unusedDispatch = (): never => {
  throw new Error("the ingest lane runs no harness — nothing in these cases dispatches a case");
};

function harness() {
  const campaigns = new InMemoryEvolutionCampaignStore();
  const scorecardStore = new InMemoryScorecardStore();
  let n = 0;
  const scorecards = new ScorecardService({
    campaigns,
    store: scorecardStore,
    datasets: new InMemoryDatasetRegistry(),
    // Never reached — nothing here dispatches a case; the ingest lane runs no harness. Typed as the real
    // contract so the double cannot answer a shape the production dispatcher could not.
    dispatcher: { dispatch: async (): Promise<CaseResult> => unusedDispatch() },
    defaultTraceGraders: () => [],
    newId: () => `sc-${++n}`,
  });
  const campaignService = new CampaignService({
    store: campaigns,
    operations: campaigns,
    scorecards: scorecardStore,
    diffs: { diffSnapshot: async () => snapshot },
    evidence: new InMemoryCampaignEvidenceStore(),
    issues: {
      async get() {
        return { id: "iss_1" };
      },
    },
    datasets: {
      get: async (): Promise<never> => {
        throw new NotFoundError("NOT_FOUND", {}, "no dataset registry in this fixture");
      },
    },
    seedProvenance: {
      seedsOf: async () => ({ kind: "read" as const, value: undefined }),
      evidenceOf: async () => ({ kind: "read" as const, value: [] }),
    },
    shape: { slotsOf: async () => ({ kind: "read" as const, value: [{ slot: "image", tools: [] }] }) },
    changes: {
      pullRequestFiles: async () => readUnknown<{ paths: string[]; complete: boolean }>("no reader in this fixture"),
    },
    runs: { get: async () => undefined },
    newId: () => `evc-${++n}`,
    now: () => "2026-09-09T00:00:00.000Z",
  });
  return { campaigns, scorecards, campaignService };
}

const ingestArm = (scorecards: ScorecardService, campaignId: string, side: "baseline" | "candidate", version: string) =>
  scorecards.ingest({
    tenant: "acme",
    harness: { id: "agent:everdict", version },
    traces: shadowTries,
    judges: [],
    campaignEvaluation: { campaignId, requestId: "round-1", candidateVersion: "1.0.1", side },
  });

describe("[COUNTEREXAMPLE] the shadow-try procedure can reserve its comparison through the door it uploads to", () => {
  it("an ingested pair reserved on both arms is accepted as a round", async () => {
    // Given: the campaign the agent procedure opens
    const { campaigns, scorecards, campaignService } = harness();
    const campaign = await campaignService.open("acme", { issueId: "iss_1", frame }, "agent:everdict");

    // When: it uploads both arms through `ingest_scorecard`, reserving one comparison
    const baseline = await ingestArm(scorecards, campaign.id, "baseline", "1.0.0");
    const candidate = await ingestArm(scorecards, campaign.id, "candidate", "1.0.1");

    // Then: the ledger holds ONE comparison bound to the two server-minted scorecard ids
    const reserved = await campaigns.evaluationForScorecard("acme", candidate.id);
    expect(reserved?.baseline?.scorecardId).toBe(baseline.id);
    expect(reserved?.candidate?.scorecardId).toBe(candidate.id);
    expect((await campaigns.family("acme", campaign.id))?.consumed).toBe(1);

    // …and the round the procedure logs next is accepted
    const { round } = await campaignService.logRound(
      "acme",
      campaign.id,
      {
        hypothesis: "a tighter stop condition",
        learned: "the tool budget was the binding constraint, not the prompt",
        candidateVersion: "1.0.1",
        baselineScorecardId: baseline.id,
        candidateScorecardId: candidate.id,
      },
      "agent:everdict",
    );
    expect(round.verdict.evaluationId).toBe(reserved?.id);
    expect((await campaigns.evaluationForScorecard("acme", candidate.id))?.reportedRound).toBe(1);
  });

  it("an ingest that reserved nothing still cannot become a round", async () => {
    const { scorecards, campaignService } = harness();
    const campaign = await campaignService.open("acme", { issueId: "iss_1", frame }, "agent:everdict");
    const bare = (version: string) =>
      scorecards.ingest({
        tenant: "acme",
        harness: { id: "agent:everdict", version },
        traces: shadowTries,
        judges: [],
      });
    const baseline = await bare("1.0.0");
    const candidate = await bare("1.0.1");
    await expect(
      campaignService.logRound(
        "acme",
        campaign.id,
        {
          hypothesis: "h",
          learned: "the tool budget was the binding constraint",
          candidateVersion: "1.0.1",
          baselineScorecardId: baseline.id,
          candidateScorecardId: candidate.id,
        },
        "agent:everdict",
      ),
    ).rejects.toThrow(/reserved before both scorecards were submitted/);
  });

  it("a ragged upload cannot pass as a full arm — repeated caseIds ARE the trials", async () => {
    // Given: two tries for c1 and one for c2, under a frame that froze `trialsPerCase: 2`
    const { scorecards, campaignService } = harness();
    const campaign = await campaignService.open("acme", { issueId: "iss_1", frame }, "agent:everdict");
    await expect(
      scorecards.ingest({
        tenant: "acme",
        harness: { id: "agent:everdict", version: "1.0.0" },
        traces: [traceOf("c1"), traceOf("c1"), traceOf("c2")],
        judges: [],
        campaignEvaluation: {
          campaignId: campaign.id,
          requestId: "round-1",
          candidateVersion: "1.0.1",
          side: "baseline",
        },
      }),
    ).rejects.toThrow(/same number of traces for every scenario/);
  });

  it("an upload that ran a different slice than the frame froze is refused at the door", async () => {
    const { scorecards, campaignService } = harness();
    const campaign = await campaignService.open("acme", { issueId: "iss_1", frame }, "agent:everdict");
    await expect(
      scorecards.ingest({
        tenant: "acme",
        harness: { id: "agent:everdict", version: "1.0.0" },
        traces: [traceOf("c1"), traceOf("c1")],
        judges: [],
        campaignEvaluation: {
          campaignId: campaign.id,
          requestId: "round-1",
          candidateVersion: "1.0.1",
          side: "baseline",
        },
      }),
    ).rejects.toThrow(/exactly its frozen scenarios and trials/);
  });

  it("a deployment with no family ledger REFUSES a campaign ingest rather than accepting an unreserved one", async () => {
    const scorecards = new ScorecardService({
      store: new InMemoryScorecardStore(),
      datasets: new InMemoryDatasetRegistry(),
      // Never reached — nothing here dispatches a case; the ingest lane runs no harness. Typed as the real
      // contract so the double cannot answer a shape the production dispatcher could not.
      dispatcher: { dispatch: async (): Promise<CaseResult> => unusedDispatch() },
      defaultTraceGraders: () => [],
      newId: () => "sc-x",
    });
    await expect(
      scorecards.ingest({
        tenant: "acme",
        harness: { id: "agent:everdict", version: "1.0.0" },
        traces: shadowTries,
        judges: [],
        campaignEvaluation: {
          campaignId: "evc-1",
          requestId: "round-1",
          candidateVersion: "1.0.1",
          side: "baseline",
        },
      }),
    ).rejects.toThrow(/campaign evaluation ledger is not configured/);
  });
});
