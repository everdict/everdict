import type { CaseResult, PublicationPlan, ScorecardExport, ScorecardRecord } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { ScorecardStore, ScorecardUpdateGuard } from "../ports/scorecard-store.js";
import { PublicationCoordinator, drainPublication, planPublication } from "./publication.js";
import { type AnalysisBundle, analysisArtifactKey, analysisPassKey } from "./scorecard-observability.js";

// ── A COMMITTED SETTLEMENT PUBLISHES EXACTLY ONCE (arch-review 52, Wave 4) ───────────────────────────
//
// The plan rides the terminal transaction, so the effects it owes can no longer be performed by an attempt
// that has not won. What this file pins is the other half of that claim: the plan is drained ONCE. Two
// publishers exist by construction — the winner drains inline, and the reconciler sweeps whatever a crash
// left owed — so "the sweep overlaps the inline drain" is the ordinary case, not the exotic one.
const SCORECARD_ID = "sc-1";
const PASS_ID = "initial-abc";

const results: CaseResult[] = [
  {
    caseId: "c1",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "done" },
    scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
  },
];

const bundle: AnalysisBundle = {
  scorecardId: SCORECARD_ID,
  dataset: "d@1.0.0",
  harness: "h@1",
  summary: [],
  cases: [{ caseId: "c1", verdict: true, scores: results[0]?.scores ?? [] }],
  infra: { failedCases: 0, byClass: {}, byCode: {}, oom: 0, placementBlocked: 0 },
};

function record(plan: PublicationPlan): ScorecardRecord {
  return {
    id: SCORECARD_ID,
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "succeeded",
    publication: plan,
    scorecard: { suiteId: "d", harness: "h@1", results },
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:01.000Z",
  } as unknown as ScorecardRecord;
}

// A store that enforces the one guard this file is about. `expectPublicationState` is what makes the drain a
// compare-and-swap rather than a read-then-write, so a fake that ignored it would let both publishers "win".
function fakeStore(initial: ScorecardRecord): { store: ScorecardStore; current: () => ScorecardRecord } {
  let held = initial;
  const store: ScorecardStore = {
    async create() {
      throw new Error("unused");
    },
    async update(id: string, patch: Partial<ScorecardRecord>, _events, guard?: ScorecardUpdateGuard) {
      if (id !== held.id) return undefined;
      if (guard?.expectPublicationState !== undefined && held.publication?.state !== guard.expectPublicationState)
        return undefined;
      held = { ...held, ...patch };
      return held;
    },
    async get() {
      return held;
    },
    async list(_tenant, filter) {
      if (filter?.publicationPending === true && held.publication?.state !== "pending") return [];
      return [held];
    },
    async delete() {
      return false;
    },
  };
  return { store, current: () => held };
}

function fakeArtifacts(seeded: Record<string, unknown>): { artifacts: ArtifactStore; puts: string[] } {
  const objects = new Map<string, Buffer>(
    Object.entries(seeded).map(([k, v]) => [k, Buffer.from(JSON.stringify(v))] as const),
  );
  const puts: string[] = [];
  return {
    puts,
    artifacts: {
      async put(key, bytes) {
        puts.push(key);
        objects.set(key, Buffer.from(bytes));
        return `https://artifacts.invalid/${key}`;
      },
      async get(key) {
        return objects.get(key);
      },
      async publicUrlFor() {
        return undefined;
      },
    },
  };
}

// `planPublication` answers `undefined` for a settlement that owes nothing outward; every case here plans a
// real debt, so an absent plan is a broken fixture rather than a case to branch on.
function mustPlan(plan: PublicationPlan | undefined): PublicationPlan {
  if (!plan) throw new Error("fixture planned no publication");
  return plan;
}

const exportReceipt: ScorecardExport = {
  sink: "mlflow",
  status: "succeeded",
  exportedAt: "2026-08-15T00:00:02.000Z",
  cases: [{ caseId: "c1", externalId: "tr-1" }],
};

describe("the publication outbox", () => {
  it("publishes a committed plan exactly once, however many publishers drain it", async () => {
    // Given a settlement whose plan committed: the analysis bundle is staged under its content-addressed
    // pass key, and the alias + the export are owed.
    const plan = mustPlan(
      planPublication({
        scorecardId: SCORECARD_ID,
        bundle,
        staged: { revisionKey: analysisPassKey(SCORECARD_ID, PASS_ID) },
        passId: PASS_ID,
        exports: true,
        results,
        now: "2026-08-15T00:00:01.000Z",
      }),
    );
    const { store, current } = fakeStore(record(plan));
    const { artifacts, puts } = fakeArtifacts({ [analysisPassKey(SCORECARD_ID, PASS_ID)]: bundle });
    const exports: string[] = [];
    const deps = {
      store,
      artifacts,
      exportResults: async (): Promise<ScorecardExport> => {
        exports.push(SCORECARD_ID);
        return exportReceipt;
      },
    };
    const now = (): string => "2026-08-15T00:00:03.000Z";

    // When the winner drains it inline and the reconciler sweeps immediately afterwards.
    const first = await drainPublication(deps, record(plan), results, now);
    const coordinator = new PublicationCoordinator({ ...deps, getRecord: async () => current(), now });
    const swept = await coordinator.reconcile();

    // Then exactly one of them published: one export left the building, one receipt is on the record.
    expect(first.kind).toBe("published");
    expect(exports).toEqual([SCORECARD_ID]);
    expect(swept).toBe(0); // the sweep found nothing owed — the plan is no longer pending
    expect(current().export).toEqual(exportReceipt);
    expect(current().publication?.state).toBe("published");
    // …and the mutable alias was promoted from the staged object, exactly once.
    expect(puts).toEqual([analysisArtifactKey(SCORECARD_ID)]);
  });

  it("a plan whose staged bytes are not the ones it planned promotes nothing and stays owed", async () => {
    // Given a staged object under this settlement's key whose content is NOT the bundle the plan digested —
    // the shape a re-keyed or half-written artifact takes. Promoting it would put another pass's bundle
    // behind this batch's current-analysis alias, which is the collision the pass key exists to prevent.
    const plan = mustPlan(
      planPublication({
        scorecardId: SCORECARD_ID,
        bundle,
        staged: { revisionKey: analysisPassKey(SCORECARD_ID, PASS_ID) },
        passId: PASS_ID,
        exports: false,
        results,
        now: "2026-08-15T00:00:01.000Z",
      }),
    );
    const { store, current } = fakeStore(record(plan));
    const { artifacts, puts } = fakeArtifacts({
      [analysisPassKey(SCORECARD_ID, PASS_ID)]: { ...bundle, dataset: "someone-else@9" },
    });

    const outcome = await drainPublication({ store, artifacts }, record(plan), results, () => "t");

    expect(outcome).toEqual({
      kind: "owed",
      reason: `the staged analysis artifact '${analysisPassKey(SCORECARD_ID, PASS_ID)}' does not digest to the planned bundle`,
    });
    expect(puts).toEqual([]);
    // The plan is still owed — with the reason recorded for an operator, which is diagnostics and never control.
    expect(current().publication?.state).toBe("pending");
    expect(current().publication?.lastError).toContain("does not digest");
  });

  it("does not export a plane the settlement never counted", async () => {
    // Given a plan whose payload digest is the results the settle counted, and a drain handed a DIFFERENT
    // plane (a re-score landed in the crash window). Exporting the newer bytes under the older settlement's
    // receipt is the substitution this whole seam exists to prevent.
    const plan = mustPlan(
      planPublication({
        scorecardId: SCORECARD_ID,
        bundle,
        staged: {},
        passId: PASS_ID,
        exports: true,
        results,
        now: "2026-08-15T00:00:01.000Z",
      }),
    );
    expect(plan.exports?.[0]?.payloadDigest).toBe(contentDigest(results));
    const { store, current } = fakeStore(record(plan));
    const exports: string[] = [];
    const rescored: CaseResult[] = [{ ...results[0], scores: [] } as CaseResult];

    const outcome = await drainPublication(
      {
        store,
        exportResults: async (): Promise<ScorecardExport> => {
          exports.push(SCORECARD_ID);
          return exportReceipt;
        },
      },
      record(plan),
      rescored,
      () => "t",
    );

    expect(outcome.kind).toBe("owed");
    expect(exports).toEqual([]);
    expect(current().export).toBeUndefined();
  });

  it("the reconciler drains a plan the winner's process never got to", async () => {
    // Given a settlement that committed and whose publisher died before draining — the crash window the
    // outbox exists for. Nothing but the durable plan says the effects are owed.
    const plan = mustPlan(
      planPublication({
        scorecardId: SCORECARD_ID,
        bundle,
        staged: { revisionKey: analysisPassKey(SCORECARD_ID, PASS_ID) },
        passId: PASS_ID,
        exports: true,
        results,
        now: "2026-08-15T00:00:01.000Z",
      }),
    );
    const { store, current } = fakeStore(record(plan));
    const { artifacts, puts } = fakeArtifacts({ [analysisPassKey(SCORECARD_ID, PASS_ID)]: bundle });
    const exports: string[] = [];
    const coordinator = new PublicationCoordinator({
      store,
      artifacts,
      exportResults: async (): Promise<ScorecardExport> => {
        exports.push(SCORECARD_ID);
        return exportReceipt;
      },
      getRecord: async () => current(),
      now: () => "2026-08-15T00:00:09.000Z",
    });

    expect(await coordinator.reconcile()).toBe(1);

    expect(exports).toEqual([SCORECARD_ID]);
    expect(puts).toEqual([analysisArtifactKey(SCORECARD_ID)]);
    expect(current().publication?.state).toBe("published");
    expect(current().publication?.publishedAt).toBe("2026-08-15T00:00:09.000Z");
    // …and a second sweep is a no-op: the plan is the record of what is still owed, not a log of what ran.
    expect(await coordinator.reconcile()).toBe(0);
    expect(exports).toEqual([SCORECARD_ID]);
  });
});
