import {
  type CampaignComparison,
  type CampaignComparisonSide,
  CampaignService,
  type CampaignSnapshot,
} from "@everdict/application-control";
import type { CampaignFrame, ScorecardStatus } from "@everdict/contracts";
import { NotFoundError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryCampaignEvidenceStore } from "./campaign-evidence-store.js";
import { InMemoryEvolutionCampaignStore } from "./campaign-store.js";

// ── REVIEW 2026-09-09 R1: the oracle's commits were not bound to the evaluated code ─────────────────
//
// `oracleCheck` resolved the baseline commit from the baseline scorecard's `origin.sha` and the candidate's
// from the candidate scorecard's `origin.sha` whenever no platform build record existed. `origin.repo` and
// `origin.sha` are the SUBMITTER's fields — the door stamps only `origin.source` server-side and copies the
// coordinates verbatim — so the check verified that two caller-authored strings agreed and echoed them into
// its receipt as though they were evidence:
//
//   evaluate baseline B against candidate A, where A edits a protected oracle file
//   submit the BASELINE's origin with sha A
//   → the oracle compares A to A → the repository lists no changed paths → `clean`
//
// The `clean` receipt then answered a different question from the B-to-A change that was measured, and a
// campaign could adopt a candidate that had rewritten its own exam.
//
// Both commits now come from Everdict's own build ledger, joined to the evaluated arms through the instance
// version — which `logRound` has already checked against each scorecard's own harness stamp. Missing
// provenance is an explicit `unverifiable`, never a fallback to the caller's word.
//
// Seen RED before the repair with: "expected true to be false" on the forged-baseline case (the round logged
// comparable, with a clean oracle receipt naming the candidate's own sha on both sides).

const scoped: CampaignFrame = {
  subject: { type: "harness", id: "scaffold", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "c1", heldOut: true },
    { id: "c2", heldOut: true },
  ],
  judges: [],
  trialsPerCase: 5,
  budget: { maxRounds: 5 },
  stopAfterRejectedRounds: 3,
  significance: { fdrAlpha: 0.05, heldOutFamilySize: 5 },
  allowUnverifiedIdentity: false,
  allowLabelOnlyAdoption: false,
  oracleScope: ["tests/", "datasets/**"],
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
const winning: CampaignComparison = {
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

// The evaluated arms as the platform sealed them: a real harness stamp and a real spec digest, plus the
// caller-authored `origin` the submission carried. THE FORGERY LIVES IN THAT ORIGIN.
type SubmittedOrigin = NonNullable<CampaignComparisonSide["record"]["origin"]>;
const arm = (version: string, origin?: SubmittedOrigin): CampaignComparisonSide => ({
  record: {
    harness: { id: "scaffold", version },
    manifest: { harness: { specDigest: `sha256:spec-${version}` } },
    ...(origin !== undefined ? { origin } : {}),
  },
});

// Everdict's own account of what it built. `sha` is what the build session OBSERVED checked out.
const buildOf = (id: string, version: string, sha: string, prNumber?: number, repo = "acme/scaffold") => ({
  id,
  state: "built",
  candidateVersion: version,
  source: {
    git: `https://github.com/${repo}.git`,
    repo,
    ref: prNumber === undefined ? "main" : `pr-${prNumber}`,
    sha,
    ...(prNumber === undefined ? {} : { prNumber }),
  },
  base: { image: `reg/scaffold:${version}` },
});

type Deps = ConstructorParameters<typeof CampaignService>[0];

// A repository that answers honestly: a comparison of a commit with ITSELF lists nothing changed, which is
// exactly why a forged baseline used to come back clean.
//
// `mergeBaseSha` defaults to the baseline it was asked about — an `ahead` comparison, where the listing IS the
// two-tree difference (`pathsCover: "evaluated-difference"`). `divergedFrom` models the other shape GitHub
// really answers with (review 2026-09-10 R1): a three-dot comparison whose files describe merge-base→candidate
// while both attested SHAs stay genuine. The adapter covers that by unioning both sides of the fork, so a
// diverged fixture reports `fork-union` and its `changedBetween` key is the union it would have built.
const repository = (changedBetween: Record<string, string[]>, divergedFrom?: string | null) => ({
  calls: [] as Array<{ pr: number; baselineSha: string; candidateSha: string }>,
  async pullRequestFiles(
    _tenant: string,
    _repo: string,
    pr: number,
    commits: { baselineSha: string; candidateSha: string },
  ) {
    this.calls.push({ pr, ...commits });
    const key = `${commits.baselineSha}..${commits.candidateSha}`;
    return {
      kind: "read" as const,
      value: {
        paths: changedBetween[key] ?? [],
        complete: true,
        ...commits,
        // `null` is the endpoint that named no starting point at all — a different answer from "started at
        // the baseline", and refused for its own reason (rule `protocol` L2: not saying is a third value).
        ...(divergedFrom === null
          ? {}
          : {
              mergeBaseSha: divergedFrom ?? commits.baselineSha,
              pathsCover: divergedFrom === undefined ? ("evaluated-difference" as const) : ("fork-union" as const),
            }),
      },
    };
  },
});

let ids = 0;

const batches = new Map<string, ScorecardStatus>([
  ["sc-base", "succeeded"],
  ["sc-cand", "succeeded"],
]);

const service = (
  store: InMemoryEvolutionCampaignStore,
  changes: Deps["changes"],
  builds: Deps["builds"],
  snapshot: CampaignSnapshot,
) =>
  new CampaignService({
    store,
    operations: store,
    builds,
    changes,
    scorecards: {
      get: async (id: string) => {
        const status = batches.get(id);
        return status === undefined ? undefined : { tenant: "acme", status };
      },
    },
    issues: {
      async get() {
        return { id: "iss_1" };
      },
    },
    diffs: {
      async diffSnapshot() {
        return snapshot;
      },
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
    newId: () => `id_${++ids}`,
    now: () => "2026-09-09T00:00:00.000Z",
  });

const LOG = {
  hypothesis: "structure over phrasing",
  learned: "the tool budget was the binding constraint, not the prompt",
  candidateVersion: "1.0.1",
  baselineScorecardId: "sc-base",
  candidateScorecardId: "sc-cand",
};

const reserve = (store: InMemoryEvolutionCampaignStore, campaignId: string, side: "baseline" | "candidate") =>
  store.reserveEvaluation({
    tenant: "acme",
    campaignId,
    requestId: "attempt-1",
    candidateVersion: "1.0.1",
    side,
    scorecardId: side === "baseline" ? "sc-base" : "sc-cand",
    requestDigest: `sha256:${side}`,
    at: "2026-09-09T00:00:00.000Z",
    caseIds: ["c1", "c2"],
    trials: 5,
  });

// Candidate A changed a protected dataset relative to the real baseline B; comparing A with itself changes
// nothing, which is the answer the forged baseline was reaching for.
const REPO_TRUTH = { "sha-B..sha-A": ["src/loop.ts", "datasets/tb.json"] };

describe("[COUNTEREXAMPLE] the oracle compares the commits Everdict built, not the ones a caller named", () => {
  const drive = async (builds: Deps["builds"], snapshot: CampaignSnapshot, changes = repository(REPO_TRUTH)) => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store, changes, builds, snapshot);
    const rec = await svc.open("acme", { issueId: "iss_1", frame: scoped }, "alice");
    await reserve(store, rec.id, "baseline");
    await reserve(store, rec.id, "candidate");
    const { round } = await svc.logRound("acme", rec.id, LOG, "agent:everdict");
    return { round, changes };
  };

  it("a forged baseline origin naming the candidate's own commit cannot obtain a clean oracle result", async () => {
    // Given: the baseline arm's ORIGIN claims the candidate's commit — the caller's field, the caller's word
    const forged = {
      diff: winning,
      baseline: arm("1.0.0", { source: "api", repo: "acme/scaffold", sha: "sha-A" }),
      candidate: arm("1.0.1", { source: "api", repo: "acme/scaffold", sha: "sha-A", prNumber: 7 }),
    };
    const { round, changes } = await drive(
      {
        setsForCampaign: async () => [],
        forCampaign: async () => [buildOf("bld_c", "1.0.1", "sha-A", 7), buildOf("bld_b", "1.0.0", "sha-B")],
      },
      forged,
    );

    // Then: the repository was asked about the commits Everdict BUILT, not the ones the submission claimed
    expect(changes.calls).toEqual([{ pr: 7, baselineSha: "sha-B", candidateSha: "sha-A" }]);
    // …so the candidate that rewrote its exam is refused rather than certified clean
    expect(round.verdict.comparable).toBe(false);
    expect(round.verdict.oracleTouched).toEqual(["datasets/tb.json"]);
    // …and the receipt records the commits that were actually compared, not the ones the submission claimed
    expect(round.verdict.oracleReceipt).toMatchObject({ baselineSha: "sha-B", candidateSha: "sha-A" });
  });

  it("a valid provenance pair is checked, and its receipt says whose word the commits are", async () => {
    // Given: both arms built by Everdict, and the candidate's pull request stayed off the scope
    const clean = repository({ "sha-B..sha-A": ["src/loop.ts", "README.md"] });
    const { round } = await drive(
      {
        setsForCampaign: async () => [],
        forCampaign: async () => [buildOf("bld_c", "1.0.1", "sha-A", 7), buildOf("bld_b", "1.0.0", "sha-B")],
      },
      {
        diff: winning,
        baseline: arm("1.0.0"),
        candidate: arm("1.0.1"),
      },
      clean,
    );
    expect(round.verdict.comparable, round.verdict.detail).toBe(true);
    expect(round.verdict.oracleReceipt).toMatchObject({
      repository: "acme/scaffold",
      baselineSha: "sha-B",
      candidateSha: "sha-A",
      complete: true,
      commitProvenance: "everdict-build",
    });
  });

  it("R1 — a DIVERGED comparison is COVERED by both sides of the fork, and the baseline's own change is caught", async () => {
    // Reproduced against live public GitHub before any of this existed (`octocat/Hello-World`,
    // b1b3f972…...b3cbd5bb…): status `diverged`, both requested SHAs echoed back faithfully, `files` listing
    // only CONTRIBUTING.md — while the protected README genuinely differs between the two evaluated commits.
    // The production oracle answered `clean`. Nothing was forged: three-dot comparison semantics are simply a
    // different question from the one the oracle asks.
    //
    // The adapter covers it with a SECOND comparison — merge-base→baseline — and unions the two lists, which
    // is a superset of the true two-tree difference. Here the candidate touched only `src/loop.ts` since the
    // fork and the BASELINE moved `datasets/tb.json`, which a merge-base comparison alone cannot see. The
    // union carries it, so the scope check catches what the first repair could only refuse.
    const diverged = repository({ "sha-B..sha-A": ["src/loop.ts", "datasets/tb.json"] }, "sha-fork");
    const { round } = await drive(
      {
        setsForCampaign: async () => [],
        forCampaign: async () => [buildOf("bld_c", "1.0.1", "sha-A", 7), buildOf("bld_b", "1.0.0", "sha-B")],
      },
      { diff: winning, baseline: arm("1.0.0"), candidate: arm("1.0.1") },
      diverged,
    );
    expect(round.verdict.comparable).toBe(false);
    expect(round.verdict.oracleTouched).toEqual(["datasets/tb.json"]);
    // …and the receipt says WHICH question was answered, because a `touched` over a union may name a path
    // both arms changed to the same bytes, and an auditor may not infer that from three shas.
    expect(round.verdict.oracleReceipt).toMatchObject({ pathsCover: "fork-union" });
  });

  it("R1 — a diverged comparison whose union misses the scope is still CLEAN, because the union is a superset", async () => {
    // The half that makes the refusal unnecessary: a path in NEITHER side's list has the same bytes at the
    // fork, at the baseline and at the candidate, so the two evaluated trees agree on it. An ordinary pull
    // request cut before its baseline was built is diverged by definition, and this is why it can still earn
    // a clean oracle instead of being told to rebase.
    const diverged = repository({ "sha-B..sha-A": ["src/loop.ts", "README.md"] }, "sha-fork");
    const { round } = await drive(
      {
        setsForCampaign: async () => [],
        forCampaign: async () => [buildOf("bld_c", "1.0.1", "sha-A", 7), buildOf("bld_b", "1.0.0", "sha-B")],
      },
      { diff: winning, baseline: arm("1.0.0"), candidate: arm("1.0.1") },
      diverged,
    );
    expect(round.verdict.comparable, round.verdict.detail).toBe(true);
    expect(round.verdict.oracleReceipt).toMatchObject({ pathsCover: "fork-union", commitProvenance: "everdict-build" });
  });

  it("R1 — a reader that disagrees with itself is unverifiable, whichever way it disagrees", async () => {
    // `pathsCover` is a CLAIM, and the merge base is the fact that decides whether the claim is coherent.
    // A reader reporting the evaluated commits' own difference while comparing from somewhere else has not
    // covered the baseline side; one reporting a fork union while comparing from the baseline has answered
    // a question nobody asked. Neither is trusted, and the refusal says which way it broke.
    const lying = repository({ "sha-B..sha-A": [] }, "sha-fork");
    lying.pullRequestFiles = async function (_t: string, _r: string, pr: number, commits) {
      this.calls.push({ pr, ...commits });
      return {
        kind: "read" as const,
        value: {
          paths: [],
          complete: true,
          ...commits,
          mergeBaseSha: "sha-fork",
          pathsCover: "evaluated-difference" as const,
        },
      };
    };
    const { round } = await drive(
      {
        setsForCampaign: async () => [],
        forCampaign: async () => [buildOf("bld_c", "1.0.1", "sha-A", 7), buildOf("bld_b", "1.0.0", "sha-B")],
      },
      { diff: winning, baseline: arm("1.0.0"), candidate: arm("1.0.1") },
      lying,
    );
    expect(round.verdict.comparable).toBe(false);
    expect(round.verdict.detail).toMatch(/the reader disagrees with itself/);
    expect(round.verdict.oracleReceipt).toBeUndefined();
  });

  it("R1 — a listing that names no starting point is unverifiable, never assumed to have started at the baseline", async () => {
    const silent = repository({}, null);
    const { round } = await drive(
      {
        setsForCampaign: async () => [],
        forCampaign: async () => [buildOf("bld_c", "1.0.1", "sha-A", 7), buildOf("bld_b", "1.0.0", "sha-B")],
      },
      { diff: winning, baseline: arm("1.0.0"), candidate: arm("1.0.1") },
      silent,
    );
    expect(round.verdict.comparable).toBe(false);
    expect(round.verdict.detail).toMatch(/does not say where its comparison started or what its paths cover/);
    expect(round.verdict.oracleReceipt).toBeUndefined();
  });

  it("a candidate with no platform build record is unverifiable, whatever its origin claims", async () => {
    // Given: the candidate scorecard carries a perfectly well-formed origin and Everdict built nothing
    const { round, changes } = await drive(
      { setsForCampaign: async () => [], forCampaign: async () => [] },
      {
        diff: winning,
        baseline: arm("1.0.0", { source: "github-actions", repo: "acme/scaffold", sha: "sha-B" }),
        candidate: arm("1.0.1", { source: "github-actions", repo: "acme/scaffold", sha: "sha-A", prNumber: 7 }),
      },
    );
    expect(round.verdict.comparable).toBe(false);
    expect(round.verdict.detail).toMatch(/build ledger holds no build that minted scaffold@1\.0\.1/);
    // …and the repository was never asked a question built on a caller's coordinates
    expect(changes.calls).toEqual([]);
  });

  it("a baseline with no platform build record is unverifiable — the candidate's own build is not enough", async () => {
    const { round, changes } = await drive(
      { setsForCampaign: async () => [], forCampaign: async () => [buildOf("bld_c", "1.0.1", "sha-A", 7)] },
      {
        diff: winning,
        baseline: arm("1.0.0", { source: "github-actions", repo: "acme/scaffold", sha: "sha-B" }),
        candidate: arm("1.0.1"),
      },
    );
    expect(round.verdict.comparable).toBe(false);
    expect(round.verdict.detail).toMatch(/no build that minted the frame's baseline scaffold@1\.0\.0/);
    expect(changes.calls).toEqual([]);
  });

  it("a successor campaign finds its baseline's build in the predecessor's ledger", async () => {
    // Given: a predecessor that ran with no oracle scope, adopted 1.0.1, and BUILT it — so the commit behind
    // this campaign's baseline lives in that campaign's ledger, not in this one's.
    const store = new InMemoryEvolutionCampaignStore();
    const perCampaign: Record<string, ReturnType<typeof buildOf>[]> = {};
    const builds = {
      setsForCampaign: async () => [],
      forCampaign: async (_tenant: string, campaignId: string) => perCampaign[campaignId] ?? [],
    };
    const clean = repository({ "sha-B..sha-A": ["src/loop.ts"] });
    const chainFrame = { ...scoped, budget: { maxRounds: 1 }, significance: { fdrAlpha: 0.05, heldOutFamilySize: 3 } };
    const svc = service(store, clean, builds, {
      diff: winning,
      baseline: arm("1.0.0"),
      candidate: arm("1.0.1"),
    });
    // The predecessor: no oracle scope (so no pull request is needed) and a build that names none, which is
    // the honest "nothing owed" the chain check reads.
    const root = await svc.open("acme", { issueId: "iss_1", frame: { ...chainFrame, oracleScope: [] } }, "alice");
    perCampaign[root.id] = [buildOf("bld_b", "1.0.1", "sha-B")];
    await reserve(store, root.id, "baseline");
    await reserve(store, root.id, "candidate");
    expect((await svc.logRound("acme", root.id, LOG, "agent:everdict")).answer.kind).toBe("adopt");
    expect((await svc.settle("acme", root.id, "alice")).record.state).toBe("adopted");

    // The successor: baselined on what the predecessor proved, and it builds 1.0.2 from pull request #7.
    const successor = service(store, clean, builds, {
      diff: winning,
      baseline: arm("1.0.1"),
      candidate: arm("1.0.2"),
    });
    const next = await successor.open(
      "acme",
      {
        issueId: "iss_1",
        frame: {
          ...chainFrame,
          continues: root.id,
          subject: { type: "harness", id: "scaffold", baselineVersion: "1.0.1" },
        },
      },
      "alice",
    );
    perCampaign[next.id] = [buildOf("bld_c", "1.0.2", "sha-A", 7)];
    batches.set("sc-base-2", "succeeded");
    batches.set("sc-cand-2", "succeeded");
    for (const side of ["baseline", "candidate"] as const)
      await store.reserveEvaluation({
        tenant: "acme",
        campaignId: next.id,
        requestId: "attempt-2",
        candidateVersion: "1.0.2",
        side,
        scorecardId: side === "baseline" ? "sc-base-2" : "sc-cand-2",
        requestDigest: `sha256:${side}-2`,
        at: "2026-09-09T00:00:00.000Z",
        caseIds: ["c1", "c2"],
        trials: 5,
      });

    // Then: the baseline commit came from the campaign whose ledger actually built it
    const { round } = await successor.logRound(
      "acme",
      next.id,
      {
        ...LOG,
        candidateVersion: "1.0.2",
        baselineScorecardId: "sc-base-2",
        candidateScorecardId: "sc-cand-2",
      },
      "agent:everdict",
    );
    expect(round.verdict.comparable, round.verdict.detail).toBe(true);
    expect(clean.calls).toEqual([{ pr: 7, baselineSha: "sha-B", candidateSha: "sha-A" }]);
  });
});
