import {
  type AdoptionOperationStore,
  type CampaignComparison,
  CampaignService,
  type CampaignSnapshot,
  type EvolutionCampaignStore,
  type OutboxEvent,
} from "@everdict/application-control";
import type { SeedProvenanceReader } from "@everdict/application-control";
import type { CampaignFrame, CampaignRound, EvolutionCampaignRecord, Score } from "@everdict/contracts";
import {
  BadRequestError,
  ConflictError,
  EvolutionCampaignRecordSchema,
  NotFoundError,
  readUnknown,
} from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryCampaignEvidenceStore } from "./campaign-evidence-store.js";
import { InMemoryEvolutionCampaignStore, PgEvolutionCampaignStore } from "./campaign-store.js";

// The two reads a campaign service now REQUIRES and these cases do not exercise: a pull-request listing (the
// frame's oracle scope) and a delegation session (the frame's delegation budget). Stated as unavailable rather
// than omitted — an optional dep would let "not wired" read as "clean" (rule `protocol`).
const noChanges = {
  pullRequestFiles: async () =>
    readUnknown<{ paths: string[]; complete: boolean }>("no pull-request reader in this fixture"),
};
const noRuns = { get: async () => undefined };
const noDatasets = {
  get: async (): Promise<never> => {
    throw new NotFoundError("NOT_FOUND", {}, "no dataset registry in this fixture");
  },
};
// A harness with no seeds: the leak check reads "nothing to check", never "clean by default".
const noSeedProvenance = {
  seedsOf: async () => ({ kind: "read" as const, value: undefined }),
  evidenceOf: async () => ({ kind: "read" as const, value: [] }),
};
// A single-slot harness: attribution by construction, so these cases test what they are about.
const noShape = { slotsOf: async () => ({ kind: "read" as const, value: [{ slot: "image", tools: [] }] }) };

// ── The campaign settlement: store guards + the service's derived verdicts (Track D) ─────────────────
//
// The in-memory twin makes the SAME decisions as Postgres (the append CAS, the close CAS on state AND round
// count), so these units exercise the refusals production would give; the Pg half is additionally pinned at
// the SQL layer (fake SqlClient — the guards must live in the statement's WHERE, not in a read-then-write).

const frame: CampaignFrame = {
  subject: { type: "agent", id: "everdict", baselineVersion: "1.0.0" },
  // Both HELD OUT (arch-review 71 P1-high). The frame used to mark `c1` as training and these cases then
  // improved on `c1` alone — which the gate accepted, and which is exactly the defect the held-out split
  // closes: the loop adopting on the scenarios it had been optimizing against. The schema also requires at
  // least two held-out scenarios now, because one that moved is a coin flip wearing the word evidence.
  scenarios: [
    { id: "c1", heldOut: true },
    { id: "c2", heldOut: true },
  ],
  judges: [],
  trialsPerCase: 5,
  budget: { maxRounds: 5 },
  stopAfterRejectedRounds: 3,
  // The statistics this campaign is judged by, frozen like everything else the verdict depends on. The
  // fixture carries the REAL shape rather than `{}` — a default that omits a declaration turns every test
  // that does not care about statistics into a test of the undeclared branch, which is how a fixture
  // population drifts onto the weak arm (rule protocol, the fixture-drift law).
  significance: { fdrAlpha: 0.05, heldOutFamilySize: 5 },
  allowUnverifiedIdentity: false,
  allowLabelOnlyAdoption: false,
  oracleScope: [],
  targets: [],
  observationPolicy: { allowDivergent: false },
};

const round = (seq: number, over: Partial<CampaignRound["verdict"]> = {}): CampaignRound => ({
  seq,
  informedBy: [],
  hypothesis: "structure over phrasing",
  candidateVersion: `1.0.${seq}`,
  baselineScorecardId: "sc-base",
  candidateScorecardId: `sc-cand-${seq}`,
  verdict: {
    comparable: true,
    significantImprovements: 0,
    significantRegressions: 0,
    unverifiedAxes: [],
    confoundedAxes: [],
    ...over,
  },
  at: "2026-08-26T00:00:00.000Z",
  by: "agent:everdict",
});

const record = (over: Partial<EvolutionCampaignRecord> = {}): EvolutionCampaignRecord => ({
  id: "evc_1",
  tenant: "acme",
  issueId: "iss_1",
  frame,
  frameDigest: "sha256:frame",
  rounds: [],
  state: "open",
  createdBy: "alice",
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
  ...over,
});

const CLOSE = {
  outcome: { kind: "halted" as const, reason: "no_improvement" as const, detail: "dry" },
  at: "2026-08-26T01:00:00.000Z",
  by: "alice",
};

describe("InMemoryEvolutionCampaignStore — the guards answer, they never assume", () => {
  it("appends only against the expected round count — a stale writer gets conflict, not last-write-wins", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    await store.create(record());
    expect(await store.appendRound("acme", "evc_1", round(1), 0)).toEqual({ kind: "appended", seq: 1 });
    // A second writer that read the empty campaign is answered conflict — its round is NOT interleaved.
    expect(await store.appendRound("acme", "evc_1", round(1), 0)).toEqual({ kind: "conflict", expected: 0, actual: 1 });
    expect((await store.get("acme", "evc_1"))?.rounds).toHaveLength(1);
  });

  it("a closed campaign refuses appends as terminal, and a second close reads what won", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    await store.create(record());
    expect(await store.close("acme", "evc_1", "no_improvement", CLOSE, 0)).toEqual({ kind: "closed" });
    expect(await store.appendRound("acme", "evc_1", round(1), 0)).toEqual({
      kind: "terminal",
      state: "no_improvement",
    });
    expect(await store.close("acme", "evc_1", "adopted", { ...CLOSE }, 0)).toEqual({
      kind: "already",
      state: "no_improvement",
    });
  });

  it("a close whose gate answer was computed over a SHORTER trace is refused — the rounds are the settle's read-set", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    await store.create(record());
    // The settle read rounds=[] and computed its answer; a round lands in between.
    expect(await store.appendRound("acme", "evc_1", round(1), 0)).toEqual({ kind: "appended", seq: 1 });
    expect(await store.close("acme", "evc_1", "no_improvement", CLOSE, 0)).toEqual({
      kind: "conflict",
      expected: 0,
      actual: 1,
    });
    expect((await store.get("acme", "evc_1"))?.state).toBe("open"); // the stale answer closed nothing
  });

  it("another workspace's campaign reads as nonexistent", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    await store.create(record());
    expect(await store.get("rival", "evc_1")).toBeUndefined();
    expect(await store.appendRound("rival", "evc_1", round(1), 0)).toEqual({ kind: "absent" });
  });
});

describe("PgEvolutionCampaignStore — the guards live in the statement", () => {
  function fakeClient(rowsBySql: Array<{ match: string; rows: unknown[] }>) {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const client: SqlClient = {
      async query<R>(text: string, params?: unknown[]) {
        calls.push({ text, params });
        const hit = rowsBySql.find((r) => text.includes(r.match));
        return { rows: (hit?.rows ?? []) as R[] };
      },
    };
    return { client, calls };
  }

  it("appendRound CASes on the round count and the open state IN THE WHERE, and reads the landed count back", async () => {
    const { client, calls } = fakeClient([{ match: "WITH upd AS", rows: [{ n: 3 }] }]);
    const store = new PgEvolutionCampaignStore(client);
    const outcome = await store.appendRound("acme", "evc_1", round(3), 2);
    expect(outcome).toEqual({ kind: "appended", seq: 3 });
    const sql = calls[0]?.text ?? "";
    expect(sql).toContain("state='open'");
    expect(sql).toContain("jsonb_array_length(rounds) = $5");
    expect(calls[0]?.params?.[4]).toBe(2);
  });

  it("a refused append reads back WHY — terminal vs conflict vs absent are three different answers", async () => {
    const { client } = fakeClient([
      { match: "WITH upd AS", rows: [] },
      { match: "SELECT state, jsonb_array_length", rows: [{ state: "adopted", n: 4 }] },
    ]);
    const store = new PgEvolutionCampaignStore(client);
    expect(await store.appendRound("acme", "evc_1", round(5), 4)).toEqual({ kind: "terminal", state: "adopted" });
  });

  it("close CASes on state='open' AND the round count IN THE WHERE — never a read-then-write", async () => {
    const { client, calls } = fakeClient([{ match: "WITH upd AS", rows: [{ id: "evc_1" }] }]);
    const store = new PgEvolutionCampaignStore(client);
    expect(await store.close("acme", "evc_1", "adopted", CLOSE, 3)).toEqual({ kind: "closed" });
    const sql = calls[0]?.text ?? "";
    expect(sql).toContain("state='open'");
    expect(sql).toContain("jsonb_array_length(rounds) = $6");
    expect(calls[0]?.params?.[5]).toBe(3);
  });

  it("a refused close tells a stale gate answer apart from a lost settle race", async () => {
    const { client } = fakeClient([
      { match: "WITH upd AS", rows: [] },
      { match: "SELECT state, jsonb_array_length", rows: [{ state: "open", n: 4 }] },
    ]);
    const store = new PgEvolutionCampaignStore(client);
    // Still open, but the rounds moved: the gate's answer is stale — conflict, not already.
    expect(await store.close("acme", "evc_1", "adopted", CLOSE, 3)).toEqual({
      kind: "conflict",
      expected: 3,
      actual: 4,
    });
  });

  it("the outbox insert rides the SAME statement as each CAS, gated on the write landing", async () => {
    const { client, calls } = fakeClient([{ match: "WITH upd AS", rows: [{ n: 1, id: "evc_1" }] }]);
    const store = new PgEvolutionCampaignStore(client);
    const ev: OutboxEvent = {
      id: "ev1",
      tenant: "acme",
      kind: "campaign.round_logged",
      subject: { type: "campaign", id: "evc_1" },
      payload: {},
      message: "round",
      createdAt: "2026-08-26T00:00:00.000Z",
    };
    await store.appendRound("acme", "evc_1", round(1), 0, [ev]);
    await store.close("acme", "evc_1", "adopted", CLOSE, 1, [{ ...ev, id: "ev2", kind: "campaign.closed" }]);
    const statements = calls.filter((c) => c.text.includes("WITH upd AS"));
    expect(statements).toHaveLength(2); // one statement per write — the fact cannot land without it, nor separately
    for (const call of statements) {
      expect(call.text).toContain("everdict_platform_events");
      expect(call.text).toContain("WHERE EXISTS (SELECT 1 FROM upd)");
    }
  });
});

describe("CampaignService — verdicts are derived and frame-checked, settlements carry the gate's answer", () => {
  const issues = {
    async get(_tenant: string, ref: string) {
      if (ref !== "iss_1") throw new NotFoundError("NOT_FOUND", { ref }, "issue not found");
      return { id: "iss_1" };
    },
  };
  const snapshots = new Map<string, CampaignSnapshot>();
  const diffCalls: Array<{ opts?: { minDelta?: number; fdrAlpha?: number } }> = [];
  const diffs = {
    async diffSnapshot(
      _tenant: string,
      _b: string,
      candidateId: string,
      opts?: { minDelta?: number; fdrAlpha?: number },
    ): Promise<CampaignSnapshot> {
      diffCalls.push({ ...(opts !== undefined ? { opts } : {}) });
      const snap = snapshots.get(candidateId);
      if (!snap) throw new NotFoundError("NOT_FOUND", { candidateId }, "scorecard not found");
      return snap;
    },
  };
  let n = 0;
  // Both halves, because the settlement writes through one and the authorization is read through the other
  // — a fixture that carries only the campaign half cannot see an adoption at all.
  const service = (store: EvolutionCampaignStore & AdoptionOperationStore) =>
    new CampaignService({
      // The frame's positive control (`exam-proof.ts`). No fixture here names one, so this is never read;
      // it is REQUIRED on the deps because an optional capability hides an unwired composition root.
      scorecards: { get: async () => undefined },
      store,
      operations: store,
      changes: noChanges,
      runs: noRuns,
      datasets: noDatasets,
      seedProvenance: noSeedProvenance,
      shape: noShape,
      evidence: new InMemoryCampaignEvidenceStore(),
      issues,
      diffs,
      newId: () => `id_${++n}`,
      now: () => "2026-08-26T02:00:00.000Z",
    });

  const trialCase = (caseId: string, delta: number, significant: boolean, trials = 5) => ({
    caseId,
    baselineRate: 0.2,
    baselineTrials: trials,
    candidateRate: 0.2 + delta,
    candidateTrials: trials,
    delta,
    z: 2,
    method: "fisher" as const,
    p: 0.01,
    significant,
  });
  const comparison = (over: Partial<CampaignComparison> = {}): CampaignComparison => ({
    comparability: "full",
    trials: {
      baseline: "b",
      candidate: "c",
      zThreshold: 1.96,
      minDelta: 0,
      cases: [trialCase("c1", 0.8, true), trialCase("c2", 0, false)],
    } as CampaignComparison["trials"],
    experiment: { held: ["execution_world"], confounds: [], unverified: [] },
    ...over,
  });
  const side = (version: string, judges?: string[]) => ({
    record: {
      harness: { id: "agent:everdict", version },
      // The sealed manifest a real scorecard carries — the digest of the spec that batch actually ran. A
      // fixture without it exercises the LABEL-ONLY path, which the gate now refuses unless the frame waived
      // it (arch-review 72 P1-medium), so leaving it out would measure the waiver rather than the settlement.
      manifest: { harness: { specDigest: `sha256:spec-${version}` } },
      ...(judges !== undefined ? { orchestration: { judges: judges.map((id) => ({ id })) } } : {}),
    },
  });
  const snapshot = (
    diff: CampaignComparison,
    over: Partial<Pick<CampaignSnapshot, "baseline" | "candidate">> = {},
  ): CampaignSnapshot => ({ diff, baseline: side("1.0.0"), candidate: side("1.0.1"), ...over });

  const LOG = {
    hypothesis: "shorter instructions",
    candidateVersion: "1.0.1",
    baselineScorecardId: "sc-base",
    candidateScorecardId: "sc-win",
  };

  it("open freezes the frame with a digest and journals into a REAL issue only", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    expect(rec.frameDigest).toMatch(/^sha256:/);
    expect(rec.state).toBe("open");
    await expect(svc.open("acme", { issueId: "iss_404", frame }, "alice")).rejects.toBeInstanceOf(NotFoundError);
    expect(store.outbox().map((e) => e.kind)).toEqual(["campaign.opened"]);
  });

  it("REFUSES to decide, log or settle on a frame that predates the current rules (arch-review 75)", async () => {
    // arch-review 72 split creation from storage so a legacy campaign stays READABLE. It left the other
    // half open: such a campaign is still `open`, and a fresh round logged after the upgrade builds a
    // heldOut block from the frame's single flag — manufacturing exactly the evidence the two-scenario rule
    // exists to require, and the gate then adopts on it.
    //
    // Seen RED before the eligibility guard, observed:
    //   legacy 1-held-out frame + new round → adopt ADOPTS v1.1.0
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    // Written directly, because `open` correctly refuses this frame — the row is one an older deployment
    // stored, which is the whole premise (a fixture that could open it would be testing nothing).
    const legacy = {
      id: "camp-legacy",
      tenant: "acme",
      issueId: "iss_1",
      frame: {
        ...frame,
        scenarios: [
          { id: "only-one", heldOut: true },
          { id: "train", heldOut: false },
        ],
      },
      frameDigest: "sha256:legacy",
      rounds: [],
      state: "open" as const,
      createdBy: "alice",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.create(legacy);

    // READ still works — that is the availability half arch-review 72 bought, and it stays bought.
    expect((await svc.get("acme", "camp-legacy")).id).toBe("camp-legacy");
    expect((await svc.list("acme")).map((c) => c.id)).toContain("camp-legacy");

    // …and every path that produces or consumes NEW adoption evidence refuses, naming the remedy.
    await expect(svc.decision("acme", "camp-legacy"), "a legacy frame decided").rejects.toThrow(
      /predates the current adoption rules/,
    );
    await expect(
      svc.logRound(
        "acme",
        "camp-legacy",
        {
          hypothesis: "h",
          candidateVersion: "1.0.1",
          baselineScorecardId: "sc-b",
          candidateScorecardId: "sc-c",
        },
        "alice",
      ),
      "a legacy frame manufactured a held-out block",
    ).rejects.toThrow(/predates the current adoption rules/);
    await expect(svc.settle("acme", "camp-legacy", "alice")).rejects.toThrow(/predates the current adoption rules/);
    // Nothing was written by any of the three.
    expect((await svc.get("acme", "camp-legacy")).rounds).toHaveLength(0);
    expect((await svc.get("acme", "camp-legacy")).state).toBe("open");
  });

  it("a round's verdict comes from the diff — the caller cannot write its own report card", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    snapshots.set("sc-win", snapshot(comparison()));
    const { round: logged, answer } = await svc.logRound("acme", rec.id, LOG, "agent:everdict");
    // `toMatchObject`: the verdict also names its evidence object (key + digest), pinned by its own cases below.
    expect(logged.verdict).toMatchObject({
      comparable: true,
      significantImprovements: 1,
      significantRegressions: 0,
      // The population adoption authority actually reads (arch-review 71 P1-high). Both scenarios in this
      // frame are held out, so the one significant improvement is a held-out one — which is why the gate
      // below still answers `adopt`. On a training-only improvement it would answer `continue`.
      heldOut: { improvements: 1, regressions: 0 },
      // The bytes this round actually evaluated, taken from the candidate scorecard's sealed manifest — the
      // join an adoption is checked against (arch-review 71 P0 / 72 P1-medium).
      candidateSpecDigest: "sha256:spec-1.0.1",
      unverifiedAxes: [],
      confoundedAxes: [],
    });
    expect(answer.kind).toBe("adopt");
  });

  // ── THE HELD-OUT SET IS TESTED ONCE PER ROUND AND NOTHING WAS COUNTING (counterexample) ──────────
  //
  // `fdrAlpha` corrects across the CASES of one round — the only family `diffTrials` can see. The campaign
  // asks a second family it cannot: the same frozen held-out population, once per round, any single round
  // able to end the walk by adopting. With three held-out cases at alpha 0.05, a null candidate wins a given
  // round with probability around H x alpha/2, so a ten-round campaign adopted noise about half the time —
  // and `budget.maxRounds` bounded the SPENDING, which is not a statement about what the answer means.
  //
  // Seen RED before the frame carried a family, observed:
  //   expected { minDelta: 0.1, fdrAlpha: 0.05, … } to deeply equal { …, fdrAlpha: 0.01, … }
  //
  // The division lives at the ONE seam that derives a verdict, from a size frozen at open — never at the
  // gate, which reads rounds already recorded and would be applying a level chosen after they ran.
  it("[COUNTEREXAMPLE] the round is judged at the frame's level divided by the pre-registered family", async () => {
    // maxRounds rides along because the family may never be smaller than the rounds it must cover — a
    // campaign correcting for fewer tests than it is allowed to run has not corrected.
    const run = async (heldOutFamilySize: number, maxRounds = heldOutFamilySize): Promise<number | undefined> => {
      const svc = service(new InMemoryEvolutionCampaignStore());
      const framed: CampaignFrame = {
        ...frame,
        budget: { maxRounds },
        significance: { fdrAlpha: 0.05, heldOutFamilySize },
      };
      const rec = await svc.open("acme", { issueId: "iss_1", frame: framed }, "alice");
      snapshots.set("sc-win", snapshot(comparison()));
      diffCalls.length = 0;
      await svc.logRound("acme", rec.id, LOG, "agent:everdict");
      return diffCalls[0]?.opts?.fdrAlpha;
    };
    // A campaign that plans twice the rounds spends half the alpha on each — the whole point, and the cost.
    expect(await run(5)).toBeCloseTo(0.01, 12);
    expect(await run(10)).toBeCloseTo(0.005, 12);
    // …and a family of one IS the old behaviour, which is why it is a declaration rather than a default:
    // a campaign may say "one look" out loud, and then it may only take one.
    expect(await run(1)).toBeCloseTo(0.05, 12);
  });

  it("a round whose scorecards evaluated something else is REFUSED, never recorded", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    // Candidate scorecard actually ran 1.0.0 — the declared 1.0.1 would name a graduate nobody examined.
    snapshots.set("sc-win", snapshot(comparison(), { candidate: side("1.0.0") }));
    await expect(svc.logRound("acme", rec.id, LOG, "agent:everdict")).rejects.toBeInstanceOf(BadRequestError);
    // Wrong subject entirely.
    snapshots.set("sc-win", {
      diff: comparison(),
      baseline: { record: { harness: { id: "other-agent", version: "1.0.0" } } },
      candidate: { record: { harness: { id: "other-agent", version: "1.0.1" } } },
    });
    await expect(svc.logRound("acme", rec.id, LOG, "agent:everdict")).rejects.toBeInstanceOf(BadRequestError);
    // Baseline drifted off the frame's baseline version.
    snapshots.set("sc-win", snapshot(comparison(), { baseline: side("1.0.9") }));
    await expect(svc.logRound("acme", rec.id, LOG, "agent:everdict")).rejects.toBeInstanceOf(BadRequestError);
    expect((await svc.get("acme", rec.id)).rounds).toHaveLength(0); // nothing was logged
  });

  it("a run that drifted off the frame's scenarios or trials is a rejected round with the drift named", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    // Only the easy scenario ran — the frame's c2 (held out) is missing.
    snapshots.set(
      "sc-win",
      snapshot(
        comparison({
          trials: {
            baseline: "b",
            candidate: "c",
            zThreshold: 1.96,
            minDelta: 0,
            cases: [trialCase("c1", 0.8, true)],
          } as CampaignComparison["trials"],
        }),
      ),
    );
    const easy = await svc.logRound("acme", rec.id, LOG, "agent:everdict");
    expect(easy.round.verdict.comparable).toBe(false);
    expect(easy.round.verdict.detail).toContain("missing: c2");
    // Thin trials: the frame demands 5.
    snapshots.set(
      "sc-win",
      snapshot(
        comparison({
          trials: {
            baseline: "b",
            candidate: "c",
            zThreshold: 1.96,
            minDelta: 0,
            cases: [trialCase("c1", 0.8, true, 2), trialCase("c2", 0, false, 2)],
          } as CampaignComparison["trials"],
        }),
      ),
    );
    const thin = await svc.logRound("acme", rec.id, LOG, "agent:everdict");
    expect(thin.round.verdict.comparable).toBe(false);
    expect(thin.round.verdict.detail).toContain("fewer than the frame's 5 trials");
  });

  it("a frame that froze judges rejects a round judged by anyone else", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const judged: CampaignFrame = { ...frame, judges: ["drill-structure"] };
    const rec = await svc.open("acme", { issueId: "iss_1", frame: judged }, "alice");
    snapshots.set("sc-win", {
      diff: comparison(),
      baseline: side("1.0.0", ["other-judge"]),
      candidate: side("1.0.1", ["other-judge"]),
    });
    const wrong = await svc.logRound("acme", rec.id, LOG, "agent:everdict");
    expect(wrong.round.verdict.comparable).toBe(false);
    expect(wrong.round.verdict.detail).toContain("judges are not the frame's");
  });

  it("an axis VERIFIED different is a confound — recorded, non-comparable, and never waivable", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    // Even with the unverified-identity waiver on, a confound refuses: it is measured difference, not doubt.
    const waived: CampaignFrame = { ...frame, allowUnverifiedIdentity: true };
    const rec = await svc.open("acme", { issueId: "iss_1", frame: waived }, "alice");
    snapshots.set(
      "sc-win",
      snapshot(
        comparison({
          experiment: {
            held: [],
            confounds: [{ axis: "execution_world", detail: "resolved to different image digests" }],
            unverified: [],
          },
        }),
      ),
    );
    const { round: logged, answer } = await svc.logRound("acme", rec.id, LOG, "agent:everdict");
    expect(logged.verdict.comparable).toBe(false);
    expect(logged.verdict.confoundedAxes).toEqual(["execution_world"]);
    expect(logged.verdict.detail).toContain("confounded");
    expect(answer.kind).toBe("continue"); // a confounded win adopts nothing
  });

  it("an unverified world identity on the winning round refuses the settle and keeps the campaign open", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    snapshots.set(
      "sc-unv",
      snapshot(
        comparison({
          experiment: {
            held: [],
            confounds: [],
            unverified: [{ axis: "execution_world", reason: "unresolved", detail: "unpinned tag" }],
          },
        }),
      ),
    );
    await svc.logRound("acme", rec.id, { ...LOG, candidateScorecardId: "sc-unv" }, "agent:everdict");
    await expect(svc.settle("acme", rec.id, "alice")).rejects.toBeInstanceOf(ConflictError);
    expect((await svc.get("acme", rec.id)).state).toBe("open");
  });

  it("leaves a DECIDED adoption operation the registry write must spend (arch-review 71 P0)", async () => {
    // The production path, end to end: the service settles, and the authorization the close owes is there
    // for a registry write to present. Before this, `adopted` was a decision with no effect and no debt —
    // a settle followed by a crash left a campaign claiming adoption with no capability anywhere.
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    snapshots.set("sc-win", snapshot(comparison()));
    await svc.logRound("acme", rec.id, LOG, "agent:everdict");
    await svc.settle("acme", rec.id, "alice");

    const op = await store.forCampaign("acme", rec.id);
    expect(op, "the service settled adopted and authorized nothing").toBeDefined();
    expect(op?.state).toBe("decided");
    expect(op?.proof.campaignId).toBe(rec.id);
    expect(op?.proof.issueId, "the authorization lost the intent it was opened against").toBe("iss_1");
  });

  it("settle on an adoptable latest closes as adopted with the proving scorecard and the fact", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    snapshots.set("sc-win", snapshot(comparison()));
    await svc.logRound("acme", rec.id, LOG, "agent:everdict");
    const { record: settled, answer } = await svc.settle("acme", rec.id, "alice");
    expect(answer).toEqual({
      kind: "adopt",
      version: "1.0.1",
      provingScorecardId: "sc-win",
      waivedAxes: [],
      candidateSpecDigest: "sha256:spec-1.0.1",
    });
    expect(settled.state).toBe("adopted");
    expect(store.outbox().map((e) => e.kind)).toEqual(["campaign.opened", "campaign.round_logged", "campaign.closed"]);
    await expect(svc.settle("acme", rec.id, "alice")).rejects.toBeInstanceOf(ConflictError);
  });

  // ── A CHAIN IS ONE EXAM SPENT ACROSS SEVERAL CAMPAIGNS (counterexample) ──────────────────────────
  //
  // The family correction bounds the tests ONE campaign spends against its frozen held-out rows. "Keep
  // improving" means opening another campaign from what this one adopted — against the SAME held-out rows —
  // and a per-campaign family cannot see those tests at all. So a walk of five 5-round campaigns spends 25
  // tests against a population each frame corrected for 5, and the correction leaks straight back out
  // through the thing it exists to make honest.
  //
  // Seen RED before `continues` was verified, observed:
  //   a successor budgeting 5 more rounds over a family of 5 with 1 already spent OPENED, and its rounds
  //   were judged at 0.01 as though nothing had been asked of those rows before.
  //
  // The refusal is at OPEN because that is the only moment it can change anything: afterwards the frame is
  // frozen and its rounds are judged at a level nobody may revise.
  describe("continuing a campaign", () => {
    const adoptedPredecessor = async (store: InMemoryEvolutionCampaignStore) => {
      const svc = service(store);
      const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
      snapshots.set("sc-win", snapshot(comparison()));
      await svc.logRound("acme", rec.id, LOG, "agent:everdict");
      await svc.settle("acme", rec.id, "alice"); // adopts 1.0.1, one round spent
      return { svc, id: rec.id };
    };
    // Everything a successor must agree with its predecessor about, with the budget left to spend.
    const successor = (id: string, over: Partial<CampaignFrame> = {}): CampaignFrame => ({
      ...frame,
      continues: id,
      subject: { ...frame.subject, baselineVersion: "1.0.1" },
      budget: { maxRounds: 4 }, // 1 spent + 4 = the pre-registered family of 5
      ...over,
    });

    it("opens when the chain still fits inside the family it pre-registered", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const { svc, id } = await adoptedPredecessor(store);
      const next = await svc.open("acme", { issueId: "iss_1", frame: successor(id) }, "alice");
      expect(next.frame.continues).toBe(id);
      // …and the link rides the DIGEST, so a chain claim cannot be edited after the fact.
      expect(next.frameDigest).not.toBe((await svc.get("acme", id)).frameDigest);
    });

    it("[COUNTEREXAMPLE] REFUSES a successor whose rounds would overspend the shared family", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const { svc, id } = await adoptedPredecessor(store);
      // Five more rounds against rows already asked once, under a family pre-registered for five in total.
      const over = successor(id, { budget: { maxRounds: 5 } });
      await expect(svc.open("acme", { issueId: "iss_1", frame: over }, "alice")).rejects.toThrow(
        /spent 1 of its 5 pre-registered held-out tests/,
      );
    });

    it("refuses a predecessor that proved nothing to continue from", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = service(store);
      const open = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
      await expect(svc.open("acme", { issueId: "iss_1", frame: successor(open.id) }, "alice")).rejects.toBeInstanceOf(
        ConflictError,
      );
      // …and a chain naming a campaign that does not exist refuses with the read, never by opening.
      await expect(
        svc.open("acme", { issueId: "iss_1", frame: successor("evc_ghost") }, "alice"),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses a chain that starts somewhere other than what its predecessor proved", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const { svc, id } = await adoptedPredecessor(store);
      const drifted = successor(id, { subject: { ...frame.subject, baselineVersion: "9.9.9" } });
      await expect(svc.open("acme", { issueId: "iss_1", frame: drifted }, "alice")).rejects.toThrow(
        /a chain starts from what its predecessor proved/,
      );
    });

    it("refuses a chain over DIFFERENT held-out rows — that is another exam, and its tests do not carry", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const { svc, id } = await adoptedPredecessor(store);
      const otherExam = successor(id, {
        scenarios: [
          { id: "c1", heldOut: true },
          { id: "c3", heldOut: true },
        ],
      });
      await expect(svc.open("acme", { issueId: "iss_1", frame: otherExam }, "alice")).rejects.toThrow(/different exam/);
    });

    it("refuses a chain that re-declares its statistics — one walk, one pre-registration", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const { svc, id } = await adoptedPredecessor(store);
      // A looser level, or a bigger family, chosen AFTER seeing the predecessor's rounds. Either is a rule
      // picked with the data in hand, which is what freezing a frame exists to prevent.
      const relaxed = successor(id, { significance: { fdrAlpha: 0.05, heldOutFamilySize: 50 } });
      await expect(svc.open("acme", { issueId: "iss_1", frame: relaxed }, "alice")).rejects.toThrow(
        /a chain shares one pre-registration/,
      );
    });

    // ── A SIBLING SPENDS THE SAME ROWS (review of the chain arithmetic) ──────────────────────────────
    //
    // The walk only ever counted ANCESTORS. A successor that halts adopted nothing, so it cannot be
    // continued — the natural next move is a second successor of the same adopted predecessor, and that one
    // read `spent` as the predecessor's rounds alone. Every round the halted sibling logged consulted the
    // same held-out rows (its frame passed the same-exam check to open at all), and the family forgot them.
    //
    // RED before the fix: the third campaign opened with 1 + 4 = 5 inside a family of 5, over rows that had
    // already been asked 1 + 3 = 4 times.
    // ── A CHAIN STARTS FROM WHAT IS ON THE DEFAULT BRANCH (code-evolution-loop.md, D5) ──────────────
    //
    // An adoption whose candidate came from a pull request has registered bytes the next campaign's baseline
    // image will carry while the repository's default branch does not. A successor opened over that starts
    // from bytes whose source nobody can check out. RED before the fix: the successor opened.
    it("[COUNTEREXAMPLE] REFUSES to continue an adoption whose code debt is still owed, and allows it once merged", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = service(store);
      const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
      const origin = { source: "github-actions", repo: "acme/harness", sha: "abc123", prNumber: 7 };
      snapshots.set("sc-pr", snapshot(comparison(), { candidate: { record: { ...side("1.0.1").record, origin } } }));
      await svc.logRound("acme", rec.id, { ...LOG, candidateScorecardId: "sc-pr" }, "agent:everdict");
      await svc.settle("acme", rec.id, "alice");
      const operation = await store.forCampaign("acme", rec.id);
      expect(operation?.code?.state, "the fixture recorded no code debt, so the case measures nothing").toBe("owed");

      await expect(svc.open("acme", { issueId: "iss_1", frame: successor(rec.id) }, "alice")).rejects.toThrow(
        /adopted code that is not merged/,
      );
      // The bytes must be registered before the code can be promoted — the in-memory twin refuses like Pg.
      const digest = contentDigest((operation as NonNullable<typeof operation>).proof);
      expect(await store.markMerged("acme", rec.id, digest, { sha: "m1", at: "2026-09-02T03:00:00.000Z" })).toBe(
        "not_registered",
      );
      expect(await store.markRegistered("acme", rec.id, digest, "1.0.1")).toBe("registered");
      expect(
        await store.markMerged("acme", rec.id, "sha256:forged", { sha: "m1", at: "2026-09-02T03:00:00.000Z" }),
      ).toBe("proof_mismatch");
      expect(await store.markMerged("acme", rec.id, digest, { sha: "m1", at: "2026-09-02T03:00:00.000Z" })).toBe(
        "merged",
      );
      expect(await store.markMerged("acme", rec.id, digest, { sha: "m1", at: "2026-09-02T03:00:00.000Z" })).toBe(
        "already_merged",
      );
      expect((await store.forCampaign("acme", rec.id))?.code).toMatchObject({ state: "merged", mergedSha: "m1" });
      // …and now the walk may continue.
      expect((await svc.open("acme", { issueId: "iss_1", frame: successor(rec.id) }, "alice")).frame.continues).toBe(
        rec.id,
      );
    });

    it("an adoption whose candidate named no pull request owes no code — a chain over it is not refused for one", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const { id } = await adoptedPredecessor(store);
      expect((await store.forCampaign("acme", id))?.code).toBeUndefined();
      expect(
        await store.markMerged("acme", id, contentDigest((await store.forCampaign("acme", id))?.proof), {
          sha: "m1",
          at: "2026-09-02T03:00:00.000Z",
        }),
      ).toBe("no_code_debt");
    });

    it("[COUNTEREXAMPLE] a halted SIBLING's rounds are spent against the same rows, and the family covers them", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const { svc, id } = await adoptedPredecessor(store); // 1 round spent, family 5, adopted 1.0.1
      const sibling = await svc.open(
        "acme",
        { issueId: "iss_1", frame: successor(id, { budget: { maxRounds: 3 } }) },
        "alice",
      );
      // Three rejected rounds from the adopted baseline — the streak fires and the sibling halts.
      const nothing = comparison({
        trials: {
          baseline: "b",
          candidate: "c",
          zThreshold: 1.96,
          minDelta: 0,
          cases: [trialCase("c1", 0, false), trialCase("c2", 0, false)],
        } as CampaignComparison["trials"],
      });
      snapshots.set("sc-sibling", snapshot(nothing, { baseline: side("1.0.1"), candidate: side("1.0.2") }));
      const log = { ...LOG, candidateVersion: "1.0.2", candidateScorecardId: "sc-sibling" };
      for (let i = 0; i < 3; i += 1) await svc.logRound("acme", sibling.id, log, "agent:everdict");
      const halted = await svc.settle("acme", sibling.id, "alice");
      expect(halted.record.state, "the sibling did not halt, so the case measures nothing").toBe("no_improvement");

      // The predecessor is the only campaign that can be continued. 1 + 3 rounds have consulted these rows;
      // 4 more would make 8 against a family of 5.
      const again = successor(id, { budget: { maxRounds: 4 } });
      await expect(svc.open("acme", { issueId: "iss_1", frame: again }, "alice")).rejects.toThrow(
        /spent 4 of its 5 pre-registered held-out tests/,
      );
      // …and the arithmetic still lets a successor that FITS open: 1 + 3 spent, 1 more is 5.
      const fits = successor(id, { budget: { maxRounds: 1 } });
      expect((await svc.open("acme", { issueId: "iss_1", frame: fits }, "alice")).frame.continues).toBe(id);
    });
  });

  it("a round landing between the gate's read and the close makes the settle CONFLICT — the answer was stale", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    snapshots.set("sc-win", snapshot(comparison()));
    await svc.logRound("acme", rec.id, LOG, "agent:everdict");
    // A concurrent loop logs round 2 AFTER the settle computed its answer over 1 round — modeled by a store
    // wrapper that interleaves the append between the settle's read and its close.
    const raced: EvolutionCampaignStore & AdoptionOperationStore = {
      create: store.create.bind(store),
      get: store.get.bind(store),
      list: store.list.bind(store),
      appendRound: store.appendRound.bind(store),
      // FORWARDS THE ADOPTION RIDER. A double that drops it would make this file green over exactly the
      // defect arch-review 71 found one seam over — a forwarder that carries some riders and not others.
      close: async (tenant, id, state, close, expectedRounds, events, adoption) => {
        await store.appendRound(tenant, id, round(2, { significantImprovements: 1 }), 1);
        return store.close(tenant, id, state, close, expectedRounds, events, adoption);
      },
      forCampaign: store.forCampaign.bind(store),
      markRegistered: store.markRegistered.bind(store),
      markMerged: store.markMerged.bind(store),
      forIssue: store.forIssue.bind(store),
      markCompleted: store.markCompleted.bind(store),
      registeredOlderThan: store.registeredOlderThan.bind(store),
      // The real store's own answer, not `true`: `deferCompletion` is a conditional write (rule `testing`).
      deferCompletion: store.deferCompletion.bind(store),
    };
    const svc2 = new CampaignService({
      // The frame's positive control (`exam-proof.ts`). No fixture here names one, so this is never read;
      // it is REQUIRED on the deps because an optional capability hides an unwired composition root.
      scorecards: { get: async () => undefined },
      store: raced,
      operations: raced,
      changes: noChanges,
      runs: noRuns,
      datasets: noDatasets,
      seedProvenance: noSeedProvenance,
      shape: noShape,
      evidence: new InMemoryCampaignEvidenceStore(),
      issues,
      diffs,
      newId: () => "x",
      now: () => "t",
    });
    await expect(svc2.settle("acme", rec.id, "alice")).rejects.toBeInstanceOf(ConflictError);
    const after = await svc2.get("acme", rec.id);
    expect(after.state).toBe("open"); // the stale adopt never landed
    expect(after.rounds).toHaveLength(2);
  });

  it("a gate that answers continue refuses the settle — a campaign cannot be closed out from under its loop", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    await expect(svc.settle("acme", rec.id, "alice")).rejects.toBeInstanceOf(ConflictError);
  });

  it("a non-comparable pair is recorded as a rejected round, never a win", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    snapshots.set("sc-bad", snapshot(comparison({ comparability: "none" })));
    const { round: logged } = await svc.logRound(
      "acme",
      rec.id,
      { ...LOG, candidateScorecardId: "sc-bad" },
      "agent:everdict",
    );
    expect(logged.verdict.comparable).toBe(false);
    expect((await svc.decision("acme", rec.id)).kind).toBe("continue");
  });

  // ── THE RECORD ENFORCES ITS OWN FRAME — THE DRIVER DOES NOT HAVE TO ASK ─────────────────────────────
  //
  // The budget and the rejected streak were answered by `decision` and enforced by nobody: `logRound` appended
  // whatever came, and the gate checked the LATEST round for a win before it checked either ending. A driver
  // that never asked (or ignored a halt) could log past the budget until a round happened to win, and adopt
  // at a level the pre-registered family never covered. The write is the seam that can refuse — the append
  // CAS on the round count is what makes the refusal race-safe.
  describe("[COUNTEREXAMPLE] a round past the frame's own ending is refused at the write", () => {
    const nothing = (): CampaignComparison =>
      comparison({
        trials: {
          baseline: "b",
          candidate: "c",
          zThreshold: 1.96,
          minDelta: 0,
          cases: [trialCase("c1", 0, false), trialCase("c2", 0, false)],
        } as CampaignComparison["trials"],
      });

    it("REFUSES a round once the budget is spent — a WINNING one included — before the diff runs", async () => {
      // A streak rule that cannot fire before the budget, so the two endings are told apart.
      const budgeted: CampaignFrame = {
        ...frame,
        budget: { maxRounds: 2 },
        stopAfterRejectedRounds: 10,
        significance: { fdrAlpha: 0.05, heldOutFamilySize: 2 },
      };
      const store = new InMemoryEvolutionCampaignStore();
      const svc = service(store);
      const rec = await svc.open("acme", { issueId: "iss_1", frame: budgeted }, "alice");
      snapshots.set("sc-lose", snapshot(nothing()));
      snapshots.set("sc-win", snapshot(comparison()));
      const lose = { ...LOG, candidateScorecardId: "sc-lose" };
      await svc.logRound("acme", rec.id, lose, "agent:everdict");
      await svc.logRound("acme", rec.id, lose, "agent:everdict");
      expect(await svc.decision("acme", rec.id)).toMatchObject({ kind: "halt", reason: "budget_exhausted" });
      const before = diffCalls.length;
      await expect(svc.logRound("acme", rec.id, LOG, "agent:everdict")).rejects.toThrow(/budget/);
      expect(diffCalls.length, "the diff ran for a round the frame does not admit").toBe(before);
      expect((await svc.get("acme", rec.id)).rounds).toHaveLength(2);
    });

    it("REFUSES a round after the rejected streak fired — the campaign ended by its own rule", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = service(store);
      const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice"); // K = 3 of 5
      snapshots.set("sc-lose", snapshot(nothing()));
      snapshots.set("sc-win", snapshot(comparison()));
      const lose = { ...LOG, candidateScorecardId: "sc-lose" };
      for (let i = 0; i < 3; i += 1) await svc.logRound("acme", rec.id, lose, "agent:everdict");
      expect(await svc.decision("acme", rec.id)).toMatchObject({ kind: "halt", reason: "no_improvement" });
      await expect(svc.logRound("acme", rec.id, LOG, "agent:everdict")).rejects.toBeInstanceOf(ConflictError);
      expect((await svc.get("acme", rec.id)).rounds).toHaveLength(3);
      // …and the settle still closes it as the ending it reached.
      expect((await svc.settle("acme", rec.id, "alice")).record.state).toBe("no_improvement");
    });
  });

  // ── WHAT IS WRITTEN IS WHAT CAN BE READ BACK ──────────────────────────────────────────────────────
  //
  // The HTTP DTO bounded the caller's fields and the MCP twin did not, and the service appended the round
  // literal unparsed. `PgEvolutionCampaignStore` reads every row through `EvolutionCampaignRecordSchema`, so
  // one empty hypothesis or one 4001-character finding made that campaign — and, through `list()`, the
  // workspace's whole campaign list — unreadable. The in-memory twin never parses on read, which is why no
  // unit test saw it. The bounds are the RECORD's, applied once at the write, whichever door the round came
  // through.
  describe("[COUNTEREXAMPLE] a round the stored row could not decode is refused at the write", () => {
    it("refuses an empty hypothesis, an over-long finding and an over-long version as BAD_REQUEST, before the diff", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = service(store);
      const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
      snapshots.set("sc-win", snapshot(comparison()));
      const before = diffCalls.length;
      for (const bad of [
        { ...LOG, hypothesis: "" },
        { ...LOG, learned: "x".repeat(4001) },
        { ...LOG, candidateVersion: "9".repeat(101) },
      ]) {
        await expect(svc.logRound("acme", rec.id, bad, "agent:everdict")).rejects.toBeInstanceOf(BadRequestError);
      }
      expect(diffCalls.length, "the diff ran for a round that could never be stored").toBe(before);
      const stored = await svc.get("acme", rec.id);
      expect(stored.rounds).toHaveLength(0);
      // …and a round that IS accepted decodes through the schema the Postgres read applies.
      await svc.logRound("acme", rec.id, { ...LOG, learned: "y".repeat(4000) }, "agent:everdict");
      expect(EvolutionCampaignRecordSchema.safeParse(await svc.get("acme", rec.id)).success).toBe(true);
    });
  });

  // ── THE JUDGES THAT SCORED A SIDE ARE READ FROM THE SCORING LEDGER ─────────────────────────────────
  //
  // `verdictOf` compared the frame's judges to `record.orchestration.judges` — the SUBMIT-time pin a real
  // batch carries. An ingested scorecard has no orchestration at all, so a loop over ingested traces that
  // pinned its judges (as the agent-evolve skill told it to) had every round rejected "judges are not the
  // frame's (baseline: none; candidate: none)". The judges that produced the plane being compared are
  // stamped on the scoring ledger's current revision, on both kinds of record; that is the source.
  describe("[COUNTEREXAMPLE] the judge conformance check reads who SCORED the plane, not who was pinned at submit", () => {
    const pinned: CampaignFrame = { ...frame, judges: ["drill"] };
    // The ingest shape: a harness LABEL, a scoring ledger, no manifest and no orchestration.
    const ingested = (version: string, judges: string[]) => ({
      record: {
        harness: { id: "agent:everdict", version },
        scoring: [{ judges: judges.map((id) => ({ id, version: "1.0.0" })) }],
      },
    });

    it("a frame that froze judges accepts an ingested pair whose ledger names exactly them", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = service(store);
      const rec = await svc.open("acme", { issueId: "iss_1", frame: pinned }, "alice");
      snapshots.set(
        "sc-ledger",
        snapshot(comparison(), { baseline: ingested("1.0.0", ["drill"]), candidate: ingested("1.0.1", ["drill"]) }),
      );
      const { round: ok } = await svc.logRound(
        "acme",
        rec.id,
        { ...LOG, candidateScorecardId: "sc-ledger" },
        "agent:everdict",
      );
      expect(ok.verdict.comparable, ok.verdict.detail).toBe(true);
    });

    it("…and rejects a side whose CURRENT revision was scored by somebody else", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = service(store);
      const rec = await svc.open("acme", { issueId: "iss_1", frame: pinned }, "alice");
      snapshots.set(
        "sc-drift",
        snapshot(comparison(), { baseline: ingested("1.0.0", ["drill"]), candidate: ingested("1.0.1", ["other"]) }),
      );
      const { round: drifted } = await svc.logRound(
        "acme",
        rec.id,
        { ...LOG, candidateScorecardId: "sc-drift" },
        "agent:everdict",
      );
      expect(drifted.verdict.comparable).toBe(false);
      expect(drifted.verdict.detail).toMatch(/judges are not the frame's/);
    });
  });

  // ── COVERAGE IS A FRACTION OF WHAT COULD HAVE BEEN ASSESSED ────────────────────────────────────────
  //
  // `eligible` counted every measured score, and only a judge can carry an observation assessment — a cost
  // or a step count structurally cannot. Ingest always derives steps/cost/latency beside the judge scores, so
  // one judge per case put the coverage ceiling at 0.25 and `minimumCoverage: 0.5` was unreachable for the
  // exact loop the policy was written for. The denominator is the judge family.
  describe("[COUNTEREXAMPLE] observation coverage counts only the scores a judge could have assessed", () => {
    it("a judge verdict is eligible; a cost and a step count are not", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = service(store);
      const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
      const scores: Score[] = [
        {
          graderId: "judge:drill",
          metric: "judge:drill",
          value: 1,
          pass: true,
          observationAssessment: { status: "consistent" },
        },
        { graderId: "cost", metric: "cost_usd", value: 0.2 },
        { graderId: "steps", metric: "steps", value: 12 },
      ];
      snapshots.set(
        "sc-cov",
        snapshot(comparison(), {
          candidate: { record: { ...side("1.0.1").record, scorecard: { results: [{ scores }, { scores }] } } },
        }),
      );
      const { round: r } = await svc.logRound(
        "acme",
        rec.id,
        { ...LOG, candidateScorecardId: "sc-cov" },
        "agent:everdict",
      );
      expect(r.verdict.observations).toEqual({ divergent: 0, unclear: 0, assessed: 2, eligible: 2 });
    });
  });

  // ── WHERE THE CANDIDATE CAME FROM (docs/architecture/code-evolution-loop.md, D4) ──────────────────
  //
  // A round named a version and nothing else; the pull request, the sha and the image swap that produced it
  // sat on the candidate scorecard's `origin`. The service copies them onto the round — from the RECORD, not
  // from the caller's input — and an adopted close and its proof carry them forward.
  describe("the round records where its candidate came from — from the scorecard, never from the caller", () => {
    const origin = {
      source: "github-actions",
      repo: "acme/harness",
      sha: "abc123",
      ref: "refs/pull/7/head",
      prNumber: 7,
      runUrl: "https://ci/run/9",
      pinOverrides: { web: "ghcr.io/acme/web@sha256:feed" },
    };
    const built = (version: string) => ({ record: { ...side(version).record, origin } });

    it("copies the candidate scorecard's origin onto the verdict, and onto an adopted close and its proof", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = service(store);
      const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
      snapshots.set("sc-built", snapshot(comparison(), { candidate: built("1.0.1") }));
      const { round: logged } = await svc.logRound(
        "acme",
        rec.id,
        { ...LOG, candidateScorecardId: "sc-built" },
        "agent:everdict",
      );
      expect(logged.verdict.candidateSource).toEqual(origin);
      const settled = await svc.settle("acme", rec.id, "alice");
      expect(settled.record.close?.outcome).toMatchObject({
        kind: "adopted",
        candidateSource: { sha: "abc123", prNumber: 7 },
      });
      const operation = await store.forCampaign("acme", rec.id);
      expect(operation?.proof.candidateSource?.sha).toBe("abc123");
      // …and the CODE DEBT the close owes (D5): born from the proof, owed until the merge effect pays it.
      expect(operation?.code).toEqual({ repo: "acme/harness", prNumber: 7, sha: "abc123", state: "owed" });
      // …and the fact says which commit was adopted, for a feed or a merge reaction to read.
      const closed = store.outbox().find((e) => e.kind === "campaign.closed");
      expect(closed?.payload).toMatchObject({
        candidateRepo: "acme/harness",
        candidateSha: "abc123",
        candidatePrNumber: 7,
      });
    });

    it("[D2] Everdict's own build account outranks the scorecard origin — source everdict-build with the observed commit", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const builds = {
        setsForCampaign: async () => [],
        forCampaign: async () => [
          {
            id: "bld_1",
            state: "built",
            candidateVersion: "1.0.1",
            source: {
              git: "https://github.com/acme/scaffold.git",
              repo: "acme/scaffold",
              ref: "pr-7",
              sha: "observed-sha",
              prNumber: 7,
            },
            image: { ref: "reg/ns/scaffold-image:sha-observed@sha256:beef" },
            base: { image: "reg/scaffold:1.0.0" },
          },
        ],
      };
      const svc = new CampaignService({
        // The frame's positive control (`exam-proof.ts`). No fixture here names one, so this is never read;
        // it is REQUIRED on the deps because an optional capability hides an unwired composition root.
        scorecards: { get: async () => undefined },
        store,
        operations: store,
        changes: noChanges,
        runs: noRuns,
        datasets: noDatasets,
        seedProvenance: noSeedProvenance,
        shape: noShape,
        evidence: new InMemoryCampaignEvidenceStore(),
        builds,
        issues,
        diffs,
        newId: () => `id_${++n}`,
        now: () => "2026-09-02T02:00:00.000Z",
      });
      const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
      // The scorecard also carries a (caller-authored) github-actions origin; the BUILD account wins.
      snapshots.set(
        "sc-built",
        snapshot(comparison(), {
          candidate: {
            record: {
              ...side("1.0.1").record,
              origin: { source: "github-actions", repo: "acme/scaffold", sha: "caller-sha" },
            },
          },
        }),
      );
      const { round: logged } = await svc.logRound(
        "acme",
        rec.id,
        { ...LOG, candidateScorecardId: "sc-built" },
        "agent:everdict",
      );
      expect(logged.verdict.candidateSource).toMatchObject({
        source: "everdict-build",
        sha: "observed-sha",
        prNumber: 7,
        image: "reg/ns/scaffold-image:sha-observed@sha256:beef",
        baseImage: "reg/scaffold:1.0.0",
        buildId: "bld_1",
      });
    });

    // ── THE ORACLE READS THE CHANGE EVERDICT BUILT (D2 meets D3) ──────────────────────────────────
    //
    // RED before the fix: the oracle check read only the scorecard's origin, while the build account — which
    // outranks it for the verdict — was read AFTER it. A driver-submitted batch carries no `origin.prNumber`,
    // so every oracle-scoped round of an Everdict-built candidate was "unverifiable", and the first-party code
    // loop could not adopt under an oracle scope at all.
    const buildLedger = (prNumber: number, repo = "acme/scaffold") => ({
      setsForCampaign: async () => [],
      forCampaign: async () => [
        {
          id: "bld_1",
          state: "built",
          candidateVersion: "1.0.1",
          source: { git: `https://github.com/${repo}.git`, repo, ref: `pr-${prNumber}`, sha: "observed-sha", prNumber },
          image: { ref: "reg/ns/scaffold-image:sha-observed@sha256:beef" },
          base: { image: "reg/scaffold:1.0.0" },
        },
      ],
    });
    const scopedFrame: CampaignFrame = { ...frame, oracleScope: ["tests/", "datasets/**"] };
    const prReader = (files: Record<number, string[]>) => ({
      calls: [] as Array<{ repo: string; pr: number }>,
      async pullRequestFiles(_tenant: string, repo: string, pr: number) {
        this.calls.push({ repo, pr });
        const paths = files[pr];
        return paths === undefined
          ? { kind: "absent" as const }
          : { kind: "read" as const, value: { paths, complete: true } };
      },
    });
    const withLedger = (
      store: InMemoryEvolutionCampaignStore,
      builds: NonNullable<ConstructorParameters<typeof CampaignService>[0]["builds"]>,
      changes: ReturnType<typeof prReader>,
    ) =>
      new CampaignService({
        // The frame's positive control (`exam-proof.ts`). No fixture here names one, so this is never read;
        // it is REQUIRED on the deps because an optional capability hides an unwired composition root.
        scorecards: { get: async () => undefined },
        store,
        operations: store,
        changes,
        runs: noRuns,
        datasets: noDatasets,
        seedProvenance: noSeedProvenance,
        shape: noShape,
        evidence: new InMemoryCampaignEvidenceStore(),
        builds,
        issues,
        diffs,
        newId: () => `id_${++n}`,
        now: () => "2026-09-02T02:00:00.000Z",
      });

    it("[D2·D3] an oracle-scoped frame reads the pull request from Everdict's build record when the scorecard names none", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const changes = prReader({ 7: ["src/loop.ts", "README.md"] });
      const svc = withLedger(store, buildLedger(7), changes);
      const rec = await svc.open("acme", { issueId: "iss_1", frame: scopedFrame }, "alice");
      // The driver submitted the batch itself: an `api` origin with no repository and no pull request.
      snapshots.set(
        "sc-built-nopr",
        snapshot(comparison(), { candidate: { record: { ...side("1.0.1").record, origin: { source: "api" } } } }),
      );
      const { round: logged } = await svc.logRound(
        "acme",
        rec.id,
        { ...LOG, candidateScorecardId: "sc-built-nopr" },
        "agent:everdict",
      );
      expect(logged.verdict.comparable, logged.verdict.detail).toBe(true);
      expect(changes.calls).toEqual([{ repo: "acme/scaffold", pr: 7 }]);
      expect(logged.verdict.candidateSource).toMatchObject({ source: "everdict-build", prNumber: 7 });
    });

    it("[D2·D3] …and the build record's pull request outranks the origin's for the oracle, as it does for the verdict", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      // Origin names a clean PR #3; the build Everdict actually made came from PR #7, which rewrote a dataset.
      const changes = prReader({ 3: ["src/loop.ts"], 7: ["src/loop.ts", "datasets/tb.json"] });
      const svc = withLedger(store, buildLedger(7), changes);
      const rec = await svc.open("acme", { issueId: "iss_1", frame: scopedFrame }, "alice");
      snapshots.set(
        "sc-built-otherpr",
        snapshot(comparison(), {
          candidate: {
            record: {
              ...side("1.0.1").record,
              origin: { source: "github-actions", repo: "acme/scaffold", sha: "caller-sha", prNumber: 3 },
            },
          },
        }),
      );
      const { round: logged } = await svc.logRound(
        "acme",
        rec.id,
        { ...LOG, candidateScorecardId: "sc-built-otherpr" },
        "agent:everdict",
      );
      expect(logged.verdict.comparable, "the oracle was checked against a pull request Everdict did not build").toBe(
        false,
      );
      expect(logged.verdict.oracleTouched).toEqual(["datasets/tb.json"]);
      expect(changes.calls).toEqual([{ repo: "acme/scaffold", pr: 7 }]);
    });

    it("[D2] a build ledger that cannot be read REFUSES the round — a failed read is not 'no build' (L2)", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const broken = {
        setsForCampaign: async (): Promise<never> => {
          throw new Error("connection reset");
        },
        forCampaign: async (): Promise<never> => {
          throw new Error("connection reset");
        },
      };
      const svc = withLedger(store, broken, prReader({}));
      const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
      snapshots.set("sc-ledger-down", snapshot(comparison(), { candidate: built("1.0.1") }));
      await expect(
        svc.logRound("acme", rec.id, { ...LOG, candidateScorecardId: "sc-ledger-down" }, "agent:everdict"),
      ).rejects.toMatchObject({ status: 500, extra: { candidateVersion: "1.0.1" } });
      // Nothing was logged: the round did not go in wearing the caller's provenance.
      expect((await store.get("acme", rec.id))?.rounds).toHaveLength(0);
    });

    it("[§3] the verdict answers the frame's targets one by one, from the same significance the held-out block reads", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = service(store);
      const targeted: CampaignFrame = {
        ...frame,
        scenarios: [
          { id: "c1", heldOut: false },
          { id: "c2", heldOut: true },
          { id: "c3", heldOut: true },
        ],
        targets: ["c1"],
      };
      const rec = await svc.open("acme", { issueId: "iss_1", frame: targeted }, "alice");
      // c1 (the target) improves significantly; c2 held-out improves; c3 held-out unchanged.
      snapshots.set(
        "sc-targets",
        snapshot(
          comparison({
            trials: {
              baseline: "b",
              candidate: "c",
              zThreshold: 1.96,
              minDelta: 0,
              cases: [trialCase("c1", 0.8, true), trialCase("c2", 0.6, true), trialCase("c3", 0, false)],
            } as CampaignComparison["trials"],
          }),
        ),
      );
      const { round: logged } = await svc.logRound(
        "acme",
        rec.id,
        { ...LOG, candidateScorecardId: "sc-targets" },
        "agent:everdict",
      );
      expect(logged.verdict.targets).toEqual({ flipped: ["c1"], unflipped: [] });
      expect(logged.verdict.heldOut).toEqual({ improvements: 1, regressions: 0 });
      // …and a frame without targets records no block at all — absence is the frame's, not the data's.
      const plain = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
      snapshots.set("sc-plain", snapshot(comparison()));
      const { round: r2 } = await svc.logRound(
        "acme",
        plain.id,
        { ...LOG, candidateScorecardId: "sc-plain" },
        "agent:everdict",
      );
      expect(r2.verdict.targets).toBeUndefined();
    });

    // ── THE ROUND'S EVIDENCE IS STAGED, SEALED AND READ BACK (benchmark-evidence-spec.md §3) ──────────
    it("[§3] a logged round names an evidence object whose bytes re-digest to the seal, per case, with its run ids", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const evidence = new InMemoryCampaignEvidenceStore();
      const svc = new CampaignService({
        // The frame's positive control (`exam-proof.ts`). No fixture here names one, so this is never read;
        // it is REQUIRED on the deps because an optional capability hides an unwired composition root.
        scorecards: { get: async () => undefined },
        store,
        operations: store,
        changes: noChanges,
        runs: noRuns,
        datasets: noDatasets,
        seedProvenance: noSeedProvenance,
        shape: noShape,
        evidence,
        issues,
        diffs,
        newId: () => `id_${++n}`,
        now: () => "2026-09-02T02:00:00.000Z",
      });
      const targeted: CampaignFrame = {
        ...frame,
        scenarios: [
          { id: "c1", heldOut: false },
          { id: "c2", heldOut: true },
          { id: "c3", heldOut: true },
        ],
        targets: ["c1"],
      };
      const rec = await svc.open("acme", { issueId: "iss_1", frame: targeted }, "alice");
      const withRuns = (version: string, runs: Array<[string, string]>) => ({
        record: {
          ...side(version).record,
          scorecard: { results: runs.map(([caseId, runId]) => ({ caseId, runId, trial: 0, scores: [] })) },
        },
      });
      snapshots.set(
        "sc-evidence",
        snapshot(
          comparison({
            trials: {
              baseline: "b",
              candidate: "c",
              zThreshold: 1.96,
              minDelta: 0,
              cases: [trialCase("c1", 0.8, true), trialCase("c2", 0, false), trialCase("c3", 0, false)],
            } as CampaignComparison["trials"],
          }),
          {
            baseline: withRuns("1.0.0", [
              ["c1", "run-b1"],
              ["c2", "run-b2"],
            ]),
            candidate: withRuns("1.0.1", [
              ["c1", "run-c1"],
              ["c2", "run-c2"],
            ]),
          },
        ),
      );
      const { round: logged } = await svc.logRound(
        "acme",
        rec.id,
        { ...LOG, candidateScorecardId: "sc-evidence" },
        "agent:everdict",
      );
      const ref = logged.verdict.evidence;
      expect(ref?.key).toMatch(new RegExp(`^campaigns/${rec.id}/rounds/1/`));
      const held = await evidence.get("acme", ref?.key ?? "");
      expect(contentDigest(held)).toBe(ref?.digest);
      const read = await svc.roundEvidence("acme", rec.id, 1);
      expect(read.cases.map((c) => [c.caseId, c.heldOut, c.target, c.verdict])).toEqual([
        ["c1", false, true, "improved"],
        ["c2", true, false, "unchanged"],
        ["c3", true, false, "unchanged"],
      ]);
      expect(read.cases[0]?.traces).toEqual([
        { side: "baseline", runId: "run-b1", trial: 0 },
        { side: "candidate", runId: "run-c1", trial: 0 },
      ]);
      expect(read.aggregate).toMatchObject({ comparable: true, targets: { flipped: ["c1"], unflipped: [] } });
      // Tampered bytes are refused, never served: the round sealed a digest and the store holds something else.
      evidence.overwrite("acme", ref?.key ?? "", { ...(held as object), cases: [] });
      await expect(svc.roundEvidence("acme", rec.id, 1)).rejects.toMatchObject({ status: 409 });
      // …and a round with no evidence reference (logged before the record existed) is a 404, not an invention.
      await store.appendRound(
        "acme",
        rec.id,
        { ...logged, seq: 2, verdict: { ...logged.verdict, evidence: undefined } },
        1,
      );
      await expect(svc.roundEvidence("acme", rec.id, 2)).rejects.toMatchObject({ status: 404 });
    });

    it("[§3] a store that cannot take the evidence refuses the round — nothing is appended without its bytes", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = new CampaignService({
        // The frame's positive control (`exam-proof.ts`). No fixture here names one, so this is never read;
        // it is REQUIRED on the deps because an optional capability hides an unwired composition root.
        scorecards: { get: async () => undefined },
        store,
        operations: store,
        changes: noChanges,
        runs: noRuns,
        datasets: noDatasets,
        seedProvenance: noSeedProvenance,
        shape: noShape,
        evidence: {
          put: async (): Promise<never> => {
            throw new Error("object store down");
          },
          get: async () => undefined,
        },
        issues,
        diffs,
        newId: () => `id_${++n}`,
        now: () => "2026-09-02T02:00:00.000Z",
      });
      const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
      snapshots.set("sc-no-evidence", snapshot(comparison()));
      await expect(
        svc.logRound("acme", rec.id, { ...LOG, candidateScorecardId: "sc-no-evidence" }, "agent:everdict"),
      ).rejects.toThrow(/object store down/);
      expect((await store.get("acme", rec.id))?.rounds).toHaveLength(0);
    });

    // ── A SEED BORN FROM THE EXAM IS A LEAK (harness-identity-and-seeds-spec.md §4) ─────────────────
    //
    // RED before the check: a candidate seeded with a knowledge entry whose evidence named the frame's own
    // held-out cases logged as a comparable win.
    it("[§4] a candidate seeded with knowledge born from the held-out cases is not comparable, and the seeds are named", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const harnessFrame: CampaignFrame = {
        ...frame,
        subject: { type: "harness", id: "shop", baselineVersion: "1.0.0" },
      };
      const seeds = { skills: [], knowledge: [{ id: "k-exam", digest: "sha256:k" }] };
      const provenance = (caseIds: string[]) => ({
        seedsOf: async () => ({ kind: "read" as const, value: seeds }),
        evidenceOf: async () => ({
          kind: "read" as const,
          value: [{ seed: "knowledge:k-exam", scorecardId: "sc-older", caseIds }],
        }),
      });
      const build = (seedProvenance: SeedProvenanceReader) =>
        new CampaignService({
          // The frame's positive control (`exam-proof.ts`). No fixture here names one, so this is never read;
          // it is REQUIRED on the deps because an optional capability hides an unwired composition root.
          scorecards: { get: async () => undefined },
          store,
          operations: store,
          changes: noChanges,
          runs: noRuns,
          datasets: noDatasets,
          seedProvenance,
          shape: noShape,
          evidence: new InMemoryCampaignEvidenceStore(),
          issues,
          diffs,
          newId: () => `id_${++n}`,
          now: () => "2026-09-02T02:00:00.000Z",
        });
      const shopSide = (version: string) => ({ record: { ...side(version).record, harness: { id: "shop", version } } });
      snapshots.set("sc-seeded", snapshot(comparison(), { baseline: shopSide("1.0.0"), candidate: shopSide("1.0.1") }));
      const leaking = build(provenance(["c2", "zz"])); // c2 is held-out in `frame`
      const rec = await leaking.open("acme", { issueId: "iss_1", frame: harnessFrame }, "alice");
      const { round: logged } = await leaking.logRound(
        "acme",
        rec.id,
        { ...LOG, candidateScorecardId: "sc-seeded" },
        "agent:everdict",
      );
      expect(logged.verdict.comparable, "a candidate seeded with the exam logged as comparable").toBe(false);
      expect(logged.verdict.seedLeak).toEqual(["knowledge:k-exam"]);
      expect(logged.verdict.detail).toMatch(/seeded with the exam/);
      // The same seeds under a frame whose held-out cases the evidence never touched: clean, comparable.
      const clean = build(provenance(["zz"]));
      const rec2 = await clean.open("acme", { issueId: "iss_1", frame: harnessFrame }, "alice");
      const { round: r2 } = await clean.logRound(
        "acme",
        rec2.id,
        { ...LOG, candidateScorecardId: "sc-seeded" },
        "agent:everdict",
      );
      expect(r2.verdict.comparable, r2.verdict.detail).toBe(true);
      expect(r2.verdict.seedLeak).toBeUndefined();
      // …and provenance that could not be read is unverifiable, never clean.
      const unknown = build({
        ...provenance([]),
        evidenceOf: async () => ({ kind: "unknown" as const, reason: "knowledge store down" }),
      });
      const rec3 = await unknown.open("acme", { issueId: "iss_1", frame: harnessFrame }, "alice");
      const { round: r3 } = await unknown.logRound(
        "acme",
        rec3.id,
        { ...LOG, candidateScorecardId: "sc-seeded" },
        "agent:everdict",
      );
      expect(r3.verdict.comparable).toBe(false);
      expect(r3.verdict.detail).toMatch(/could not be checked/);
    });

    // ── DIAGNOSES AND ATTRIBUTION ON THE EVIDENCE (evidence spec §2 · routing spec §2) ──────────────
    it("[§2] a judge's diagnosis on the candidate's score reaches the evidence, and a topology case is attributed to the slot it names", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const harnessFrame: CampaignFrame = {
        ...frame,
        subject: { type: "harness", id: "shop", baselineVersion: "1.0.0" },
      };
      const svc = new CampaignService({
        // The frame's positive control (`exam-proof.ts`). No fixture here names one, so this is never read;
        // it is REQUIRED on the deps because an optional capability hides an unwired composition root.
        scorecards: { get: async () => undefined },
        store,
        operations: store,
        changes: noChanges,
        runs: noRuns,
        datasets: noDatasets,
        seedProvenance: noSeedProvenance,
        shape: {
          slotsOf: async () => ({
            kind: "read" as const,
            value: [
              { slot: "web", service: "web", tools: ["browse"] },
              { slot: "api", service: "api", tools: ["query"] },
            ],
          }),
        },
        evidence: new InMemoryCampaignEvidenceStore(),
        issues,
        diffs,
        newId: () => `id_${++n}`,
        now: () => "2026-09-02T02:00:00.000Z",
      });
      const diagnosis = {
        kind: "tool_misuse",
        locus: { tool: "browse" },
        evidence: [{ eventIndex: 3 }],
        confidence: 0.9,
      };
      const candidate = {
        record: {
          ...side("1.0.1").record,
          harness: { id: "shop", version: "1.0.1" },
          scorecard: {
            results: [
              {
                caseId: "c1",
                runId: "run-c1",
                trial: 0,
                scores: [{ graderId: "behaviour", metric: "judge:behaviour", value: 0, detail: diagnosis }],
              },
              {
                caseId: "c2",
                runId: "run-c2",
                trial: 0,
                scores: [{ graderId: "behaviour", metric: "judge:behaviour", value: 1, detail: "fine" }],
              },
            ],
          },
        },
      };
      // c1 regresses significantly (the case the brief needs), c2 unchanged.
      snapshots.set(
        "sc-diag",
        snapshot(
          comparison({
            trials: {
              baseline: "b",
              candidate: "c",
              zThreshold: 1.96,
              minDelta: 0,
              cases: [trialCase("c1", -0.6, true), trialCase("c2", 0, false)],
            } as CampaignComparison["trials"],
          }),
          { baseline: { record: { ...side("1.0.0").record, harness: { id: "shop", version: "1.0.0" } } }, candidate },
        ),
      );
      const rec = await svc.open("acme", { issueId: "iss_1", frame: harnessFrame }, "alice");
      await svc.logRound("acme", rec.id, { ...LOG, candidateScorecardId: "sc-diag" }, "agent:everdict");
      const evidence = await svc.roundEvidence("acme", rec.id, 1);
      const c1 = evidence.cases.find((c) => c.caseId === "c1");
      expect(c1?.verdict).toBe("regressed");
      expect(c1?.diagnoses).toEqual([{ ...diagnosis, judge: "judge:behaviour" }]);
      expect(c1?.attribution).toMatchObject({ kind: "measured", slot: "web" });
      const c2 = evidence.cases.find((c) => c.caseId === "c2");
      expect(c2?.diagnoses).toEqual([]); // a rationale sentence is not a diagnosis
      expect(c2?.attribution).toMatchObject({ kind: "unattributed", because: ["no judge diagnosed this case"] });
    });

    it("a candidate whose scorecard carries no origin records none — absence, not an invented source", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = service(store);
      const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
      snapshots.set("sc-win", snapshot(comparison()));
      const { round: logged } = await svc.logRound("acme", rec.id, LOG, "agent:everdict");
      expect(logged.verdict.candidateSource).toBeUndefined();
    });

    it("a rejected round keeps its candidate's source — the next brief reads which pull request lost", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = service(store);
      const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
      snapshots.set("sc-built-bad", snapshot(comparison({ comparability: "none" }), { candidate: built("1.0.1") }));
      const { round: logged } = await svc.logRound(
        "acme",
        rec.id,
        { ...LOG, candidateScorecardId: "sc-built-bad" },
        "agent:everdict",
      );
      expect(logged.verdict.comparable).toBe(false);
      expect(logged.verdict.candidateSource?.prNumber).toBe(7);
    });
  });

  // ── THE CANDIDATE MAY NOT TOUCH ITS OWN EXAM (docs/architecture/code-evolution-loop.md, D3) ────────
  //
  // A coding agent with a checkout can edit the dataset, the judge rubric or the graders' tests as easily as
  // the scaffold. The frame freezes those paths; the service reads what the candidate's pull request changed
  // from the repository its scorecard names, and a hit — or a change it could not read — is a round that is
  // not comparable, whatever it scored. RED before the fix: every round below logged as a comparable win.
  describe("[COUNTEREXAMPLE] a candidate that touched the oracle scope is not comparable", () => {
    const scoped: CampaignFrame = { ...frame, oracleScope: ["tests/", "datasets/**", "judges/rubric-*.md"] };
    const origin = { source: "github-actions", repo: "acme/harness", sha: "abc123", prNumber: 7 };
    const built = (version: string, over: Partial<typeof origin> = {}) => ({
      record: { ...side(version).record, origin: { ...origin, ...over } },
    });
    const reader = (files: Record<number, { paths: string[]; complete: boolean } | "absent" | "unknown">) => ({
      calls: [] as Array<{ repo: string; pr: number }>,
      async pullRequestFiles(_tenant: string, repo: string, pr: number) {
        this.calls.push({ repo, pr });
        const answer = files[pr];
        if (answer === undefined || answer === "absent") return { kind: "absent" as const };
        if (answer === "unknown") return readUnknown<{ paths: string[]; complete: boolean }>("github said 502");
        return { kind: "read" as const, value: answer };
      },
    });
    const withReader = (store: InMemoryEvolutionCampaignStore, changes: ReturnType<typeof reader>) =>
      new CampaignService({
        // The frame's positive control (`exam-proof.ts`). No fixture here names one, so this is never read;
        // it is REQUIRED on the deps because an optional capability hides an unwired composition root.
        scorecards: { get: async () => undefined },
        store,
        operations: store,
        changes,
        runs: noRuns,
        datasets: noDatasets,
        seedProvenance: noSeedProvenance,
        shape: noShape,
        evidence: new InMemoryCampaignEvidenceStore(),
        issues,
        diffs,
        newId: () => `id_${++n}`,
        now: () => "2026-09-02T02:00:00.000Z",
      });

    it("REJECTS a winning candidate whose pull request touched a scoped path, naming the paths", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const changes = reader({
        7: { paths: ["src/loop.ts", "tests/unit/loop.test.ts", "datasets/tb.json"], complete: true },
      });
      const svc = withReader(store, changes);
      const rec = await svc.open("acme", { issueId: "iss_1", frame: scoped }, "alice");
      snapshots.set("sc-oracle", snapshot(comparison(), { candidate: built("1.0.1") }));
      const { round: logged } = await svc.logRound(
        "acme",
        rec.id,
        { ...LOG, candidateScorecardId: "sc-oracle" },
        "agent:everdict",
      );
      expect(logged.verdict.comparable, "a candidate that rewrote its exam logged as a win").toBe(false);
      expect(logged.verdict.oracleTouched).toEqual(["datasets/tb.json", "tests/unit/loop.test.ts"]);
      expect(logged.verdict.detail).toMatch(/touched the oracle/);
      expect(changes.calls).toEqual([{ repo: "acme/harness", pr: 7 }]);
      expect((await svc.decision("acme", rec.id)).kind).toBe("continue");
    });

    it("ACCEPTS a candidate whose pull request stayed off the scope — the control", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = withReader(store, reader({ 7: { paths: ["src/loop.ts", "README.md"], complete: true } }));
      const rec = await svc.open("acme", { issueId: "iss_1", frame: scoped }, "alice");
      snapshots.set("sc-clean", snapshot(comparison(), { candidate: built("1.0.1") }));
      const { round: logged } = await svc.logRound(
        "acme",
        rec.id,
        { ...LOG, candidateScorecardId: "sc-clean" },
        "agent:everdict",
      );
      expect(logged.verdict.comparable, logged.verdict.detail).toBe(true);
      expect(logged.verdict.oracleTouched).toBeUndefined();
    });

    it("REJECTS as unverifiable when the change cannot be read — no pull request, a truncated listing, a failed read", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const changes = reader({
        8: { paths: ["src/loop.ts"], complete: false },
        9: "unknown",
      });
      const svc = withReader(store, changes);
      const rec = await svc.open("acme", { issueId: "iss_1", frame: scoped }, "alice");
      // No pull request named at all: nothing to read.
      snapshots.set("sc-nopr", snapshot(comparison()));
      const noPr = await svc.logRound("acme", rec.id, { ...LOG, candidateScorecardId: "sc-nopr" }, "agent:everdict");
      expect(noPr.round.verdict.comparable).toBe(false);
      expect(noPr.round.verdict.detail).toMatch(/names no pull request/);
      // A listing the reader could not complete is not a listing.
      snapshots.set("sc-trunc", snapshot(comparison(), { candidate: built("1.0.1", { prNumber: 8 }) }));
      const trunc = await svc.logRound("acme", rec.id, { ...LOG, candidateScorecardId: "sc-trunc" }, "agent:everdict");
      expect(trunc.round.verdict.comparable).toBe(false);
      expect(trunc.round.verdict.detail).toMatch(/more files than could be listed/);
      // A read that failed is UNKNOWN, never clean.
      snapshots.set("sc-unk", snapshot(comparison(), { candidate: built("1.0.1", { prNumber: 9 }) }));
      const unk = await svc.logRound("acme", rec.id, { ...LOG, candidateScorecardId: "sc-unk" }, "agent:everdict");
      expect(unk.round.verdict.comparable).toBe(false);
      expect(unk.round.verdict.detail).toMatch(/github said 502/);
    });

    it("never asks the reader when the frame declared no scope", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const changes = reader({ 7: { paths: ["tests/unit/loop.test.ts"], complete: true } });
      const svc = withReader(store, changes);
      const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
      snapshots.set("sc-unscoped", snapshot(comparison(), { candidate: built("1.0.1") }));
      const { round: logged } = await svc.logRound(
        "acme",
        rec.id,
        { ...LOG, candidateScorecardId: "sc-unscoped" },
        "agent:everdict",
      );
      expect(logged.verdict.comparable).toBe(true);
      expect(changes.calls).toEqual([]);
    });
  });

  // ── THE DELEGATE IS BUDGETED TOO (docs/architecture/code-evolution-loop.md, delegation budget) ────────
  //
  // Rounds are bounded; the coding agent a round delegates to was not. A frame that budgets the delegation
  // makes the round name its sandbox session, and the service reads what that session cost off the RUN LEDGER
  // — never from the caller — refusing a round whose session ran past the budget. RED before the fix: the
  // field did not exist and every round below logged.
  describe("[COUNTEREXAMPLE] a round names its delegation session, and the ledger holds it to the frame's budget", () => {
    const budgeted: CampaignFrame = { ...frame, delegation: { ttlSec: 900, maxUsd: 2 } };
    type Run = { tenant: string; kind?: string; session?: { ttlSec: number }; usage?: { usd: number } };
    const ledger = (runs: Record<string, Run>) => ({ get: async (id: string) => runs[id] });
    const withRuns = (store: InMemoryEvolutionCampaignStore, runs: Record<string, Run>) =>
      new CampaignService({
        // The frame's positive control (`exam-proof.ts`). No fixture here names one, so this is never read;
        // it is REQUIRED on the deps because an optional capability hides an unwired composition root.
        scorecards: { get: async () => undefined },
        store,
        operations: store,
        changes: noChanges,
        runs: ledger(runs),
        datasets: noDatasets,
        seedProvenance: noSeedProvenance,
        shape: noShape,
        evidence: new InMemoryCampaignEvidenceStore(),
        issues,
        diffs,
        newId: () => `id_${++n}`,
        now: () => "2026-09-02T02:00:00.000Z",
      });
    const sandbox = (ttlSec: number, usd?: number): Run => ({
      tenant: "acme",
      kind: "sandbox",
      session: { ttlSec },
      ...(usd !== undefined ? { usage: { usd } } : {}),
    });

    it("REQUIRES the session under a budgeted frame, and records what the ledger says it cost", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = withRuns(store, { "run-ok": sandbox(600, 0.75) });
      const rec = await svc.open("acme", { issueId: "iss_1", frame: budgeted }, "alice");
      snapshots.set("sc-win", snapshot(comparison()));
      await expect(svc.logRound("acme", rec.id, LOG, "agent:everdict")).rejects.toBeInstanceOf(BadRequestError);
      const { round: logged } = await svc.logRound(
        "acme",
        rec.id,
        { ...LOG, delegationRunId: "run-ok" },
        "agent:everdict",
      );
      expect(logged.delegation).toEqual({ runId: "run-ok", ttlSec: 600, usd: 0.75 });
    });

    it("REFUSES a session the ledger does not know, another workspace's, or one that is not a sandbox", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = withRuns(store, {
        "run-theirs": { ...sandbox(600), tenant: "other" },
        "run-case": { tenant: "acme", kind: "eval" },
      });
      const rec = await svc.open("acme", { issueId: "iss_1", frame: budgeted }, "alice");
      snapshots.set("sc-win", snapshot(comparison()));
      for (const runId of ["run-ghost", "run-theirs"])
        await expect(
          svc.logRound("acme", rec.id, { ...LOG, delegationRunId: runId }, "agent:everdict"),
        ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        svc.logRound("acme", rec.id, { ...LOG, delegationRunId: "run-case" }, "agent:everdict"),
      ).rejects.toBeInstanceOf(BadRequestError);
      expect((await svc.get("acme", rec.id)).rounds).toHaveLength(0);
    });

    it("REFUSES a session granted more time, or one that spent more, than the frame budgets — and never scores it", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = withRuns(store, { "run-long": sandbox(3600, 0.1), "run-dear": sandbox(600, 2.5) });
      const rec = await svc.open("acme", { issueId: "iss_1", frame: budgeted }, "alice");
      snapshots.set("sc-win", snapshot(comparison()));
      await expect(
        svc.logRound("acme", rec.id, { ...LOG, delegationRunId: "run-long" }, "agent:everdict"),
      ).rejects.toThrow(/frame budgets 900s/);
      await expect(
        svc.logRound("acme", rec.id, { ...LOG, delegationRunId: "run-dear" }, "agent:everdict"),
      ).rejects.toThrow(/frame budgets \$2 per round/);
      expect((await svc.get("acme", rec.id)).rounds).toHaveLength(0);
    });

    it("records a named session without a budget, and needs none when the frame declares none", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = withRuns(store, { "run-any": sandbox(7200, 9) });
      const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
      snapshots.set("sc-win", snapshot(comparison()));
      const bare = await svc.logRound("acme", rec.id, LOG, "agent:everdict");
      expect(bare.round.delegation).toBeUndefined();
      const named = await svc.logRound("acme", rec.id, { ...LOG, delegationRunId: "run-any" }, "agent:everdict");
      expect(named.round.delegation).toEqual({ runId: "run-any", ttlSec: 7200, usd: 9 });
    });
  });
});

// ── ONE CAPABILITY'S MEMORY IS A SUBJECT FILTER (docs/architecture/evolution-routing-spec.md §5) ──────

it("returns only the campaigns whose frame subject matches, newest first", async () => {
  const store = new InMemoryEvolutionCampaignStore();
  const on = (
    id: string,
    subjectId: string,
    type: "agent" | "harness" = "harness",
    createdAt = "2026-09-02T00:00:00.000Z",
  ) =>
    store.create({
      id,
      tenant: "acme",
      issueId: "iss_1",
      frame: { ...frame, subject: { type, id: subjectId, baselineVersion: "1.0.0" } },
      frameDigest: `d-${id}`,
      rounds: [],
      state: "open",
      createdBy: "alice",
      createdAt,
      updatedAt: createdAt,
    });
  await on("c1", "shop", "harness", "2026-09-01T00:00:00.000Z");
  await on("c2", "shop", "harness", "2026-09-02T00:00:00.000Z");
  await on("c3", "other");
  await on("c4", "shop", "agent");
  expect((await store.list("acme", { type: "harness", id: "shop" })).map((r) => r.id)).toEqual(["c2", "c1"]);
  expect((await store.list("acme", { type: "harness", id: "nobody" })).map((r) => r.id)).toEqual([]);
  expect((await store.list("acme")).map((r) => r.id)).toHaveLength(4);
});
