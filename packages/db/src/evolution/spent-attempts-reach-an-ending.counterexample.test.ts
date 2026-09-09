import { type CampaignComparison, CampaignService, type CampaignSnapshot } from "@everdict/application-control";
import type { CampaignFrame, ScorecardStatus } from "@everdict/contracts";
import { ConflictError, NotFoundError, readUnknown } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryCampaignEvidenceStore } from "./campaign-evidence-store.js";
import { InMemoryEvolutionCampaignStore } from "./campaign-store.js";

// ── REVIEW 2026-09-09 R2: a spent unreported attempt could not reach a campaign ending ──────────────
//
// `budget.maxRounds` is spent by RESERVATIONS and the adoption gate counted ROUNDS. A comparison reserved and
// never reported is spent in the first number and invisible in the second, so a campaign whose only attempt
// was lost sat in a state with no exit — the reservation door answered "evaluation budget is exhausted", the
// gate answered `continue` with a round still left, and `settle` refuses `continue`.
//
// The review's probe, reproduced here against the production in-memory store and the production service:
//
//   | Reserve the sole attempt, leave the scorecard unavailable | family limit 1, consumed 1; no rounds |
//   | Ask for the decision                                      | continue, roundsLeft 1               |
//   | Reserve another attempt                                   | conflict: budget exhausted           |
//   | Settle the campaign                                       | conflict: the gate answers continue   |
//
// Seen RED before the repair with: "expected 'continue' to be 'halt'".
//
// The conservative half stays: a lost attempt is still SPENT — nothing here refunds budget. What changes is
// that its consequence reaches the ENDING, so a campaign that can no longer buy a comparison can close.

const frame: CampaignFrame = {
  subject: { type: "agent", id: "everdict", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "c1", heldOut: true },
    { id: "c2", heldOut: true },
  ],
  judges: [],
  trialsPerCase: 5,
  budget: { maxRounds: 1 },
  stopAfterRejectedRounds: 3,
  significance: { fdrAlpha: 0.05, heldOutFamilySize: 1 },
  allowUnverifiedIdentity: false,
  allowLabelOnlyAdoption: false,
  oracleScope: [],
  targets: [],
  observationPolicy: { allowDivergent: false },
};

const trialCase = (caseId: string, delta: number, significant: boolean) => ({
  caseId,
  baselineRate: 0.2,
  baselineTrials: 5,
  candidateRate: 0.2 + delta,
  candidateTrials: 5,
  delta,
  z: 2,
  method: "fisher" as const,
  p: 0.01,
  significant,
});
const winningComparison: CampaignComparison = {
  comparability: "full",
  trials: {
    baseline: "b",
    candidate: "c",
    zThreshold: 1.96,
    minDelta: 0,
    cases: [trialCase("c1", 0.8, true), trialCase("c2", 0, false)],
  } as CampaignComparison["trials"],
  experiment: { held: ["execution_world"], confounds: [], unverified: [] },
};
const side = (version: string) => ({
  record: {
    harness: { id: "agent:everdict", version },
    manifest: { harness: { specDigest: `sha256:spec-${version}` } },
  },
});
const winningSnapshot: CampaignSnapshot = {
  diff: winningComparison,
  baseline: side("1.0.0"),
  candidate: side("1.0.1"),
};

// The batches the platform holds, keyed the way `ScorecardStore.get` keys them. A test that answered
// `undefined` for every id would be asserting against the "the row is not there" arm on every attempt — the
// shape production only reaches after a crash (rule `testing`: a fixture that omits the real state turns
// every case into a test of the degraded branch).
const batches = new Map<string, ScorecardStatus>();
const scorecards = {
  get: async (id: string) => {
    const status = batches.get(id);
    return status === undefined ? undefined : { tenant: "acme", status };
  },
};

type Deps = ConstructorParameters<typeof CampaignService>[0];

const service = (store: InMemoryEvolutionCampaignStore, batchReader: Deps["scorecards"] = scorecards) =>
  new CampaignService({
    store,
    // The in-memory twin carries both halves: the settlement writes through one and the authorization is read
    // through the other, and a fixture with only the campaign half cannot see an adoption at all.
    operations: store,
    scorecards: batchReader,
    issues: {
      async get() {
        return { id: "iss_1" };
      },
    },
    diffs: {
      async diffSnapshot() {
        return winningSnapshot;
      },
    },
    changes: {
      pullRequestFiles: async () => readUnknown<{ paths: string[]; complete: boolean }>("no reader in this fixture"),
    },
    runs: { get: async () => undefined },
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
    evidence: new InMemoryCampaignEvidenceStore(),
    newId: () => "id_1",
    now: () => "2026-09-09T00:00:00.000Z",
  });

// The reservation the production submit path consumes before either arm is dispatched.
const reserve = (
  store: InMemoryEvolutionCampaignStore,
  campaignId: string,
  requestId: string,
  scorecardId: string,
  sideName: "baseline" | "candidate",
) =>
  store.reserveEvaluation({
    tenant: "acme",
    campaignId,
    requestId,
    candidateVersion: "1.0.1",
    side: sideName,
    scorecardId,
    requestDigest: `sha256:${scorecardId}`,
    at: "2026-09-09T00:00:00.000Z",
    caseIds: ["c1", "c2"],
    trials: 5,
  });

describe("[COUNTEREXAMPLE] a spent comparison that can never be reported still ends the campaign", () => {
  const open = async () => {
    batches.clear();
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    return { store, svc, id: rec.id };
  };

  it("a reservation whose scorecard was never created is spent, and the campaign can settle", async () => {
    // Given: the sole budgeted comparison is reserved and the submit then dies before the row exists —
    // the follow-up record's own words: "a crash between reservation and scorecard creation leaves the
    // attempt spent", and a replay never speculatively dispatches.
    const { store, svc, id } = await open();
    await reserve(store, id, "attempt-1", "sc-cand", "candidate");
    expect((await store.family("acme", id))?.consumed).toBe(1);

    // Then: the ending fires on the ledger the door reads, instead of on rounds nobody logged
    const answer = await svc.decision("acme", id);
    expect(answer.kind).toBe("halt");
    if (answer.kind === "halt") expect(answer.reason).toBe("budget_exhausted");
    // …and the door still refuses a second comparison: a lost attempt stays SPENT
    await expect(reserve(store, id, "attempt-2", "sc-other", "candidate")).rejects.toBeInstanceOf(ConflictError);
    // …and the campaign closes rather than staying open forever
    const settled = await svc.settle("acme", id, "alice");
    expect(settled.record.state).toBe("budget_exhausted");
  });

  it("a cancelled execution is spent the same way", async () => {
    const { store, svc, id } = await open();
    await reserve(store, id, "attempt-1", "sc-cand", "candidate");
    batches.set("sc-cand", "cancelled");
    const answer = await svc.decision("acme", id);
    expect(answer.kind).toBe("halt");
  });

  it("a completed but unreportable pair — one arm succeeded, the other failed — is spent the same way", async () => {
    const { store, svc, id } = await open();
    await reserve(store, id, "attempt-1", "sc-base", "baseline");
    await reserve(store, id, "attempt-1", "sc-cand", "candidate");
    batches.set("sc-base", "succeeded");
    batches.set("sc-cand", "failed");
    const answer = await svc.decision("acme", id);
    expect(answer.kind).toBe("halt");
    expect((await svc.settle("acme", id, "alice")).record.state).toBe("budget_exhausted");
  });

  it("exhaustion does NOT close a campaign whose reserved comparison can still finish and win", async () => {
    // Given: the last budgeted comparison is reserved and its two batches are still running
    const { store, svc, id } = await open();
    await reserve(store, id, "attempt-1", "sc-base", "baseline");
    await reserve(store, id, "attempt-1", "sc-cand", "candidate");
    batches.set("sc-base", "running");
    batches.set("sc-cand", "running");

    // Then: the campaign is live — the budget is spent, and this comparison has not answered yet
    const waiting = await svc.decision("acme", id);
    expect(waiting.kind).toBe("continue");
    await expect(svc.settle("acme", id, "alice")).rejects.toBeInstanceOf(ConflictError);

    // …and when it lands, the round is accepted and the gate adopts it
    batches.set("sc-base", "succeeded");
    batches.set("sc-cand", "succeeded");
    const logged = await svc.logRound(
      "acme",
      id,
      {
        hypothesis: "structure over phrasing",
        learned: "the tool budget was the binding constraint, not the prompt",
        candidateVersion: "1.0.1",
        baselineScorecardId: "sc-base",
        candidateScorecardId: "sc-cand",
      },
      "agent:everdict",
    );
    expect(logged.answer.kind).toBe("adopt");
    expect((await svc.settle("acme", id, "alice")).record.state).toBe("adopted");
  });

  it("a batch the store could not be read for holds the campaign open rather than ending it", async () => {
    // Given: the sole comparison is reserved and the scorecard store throws for its batch
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store, {
      get: async (): Promise<never> => {
        throw new Error("scorecard store is unreachable");
      },
    });
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    await reserve(store, rec.id, "attempt-1", "sc-cand", "candidate");

    // Then: "we could not find out" is not an ending — the campaign waits, and the refusal says why
    expect((await svc.decision("acme", rec.id)).kind).toBe("continue");
    await expect(svc.settle("acme", rec.id, "alice")).rejects.toThrow(/could not be read/);
  });
});
