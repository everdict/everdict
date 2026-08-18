import type { CaseResult, PublicationOperation, ScorecardExport, ScorecardRecord } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "../ports/artifact-store.js";
import { InMemoryPublicationOperationStore } from "../ports/publication-operation-store.js";
import type { ScorecardStore, ScorecardUpdateGuard } from "../ports/scorecard-store.js";
import { PublicationCoordinator, drainPublicationOperation, planPublicationOperation } from "./publication.js";
import { type AnalysisBundle, analysisPassKey } from "./scorecard-observability.js";

// ── A COMMITTED SETTLEMENT PUBLISHES EXACTLY ONCE (arch-review 52 Wave 4, re-based on 53 Wave C) ─────
//
// The operation rides the terminal transaction, so the effects it owes can no longer be performed by an
// attempt that has not won. What this file pins is the other half: the operation is drained ONCE. Two
// publishers exist by construction — the winner drains inline, and the reconciler sweeps whatever a crash
// left owed — so "the sweep overlaps the inline drain" is the ordinary case, not the exotic one.
//
// Wave C moved the claim from `expectPublicationState` on the scorecard row to the OPERATION's own id, and
// took it BEFORE the effects run rather than after: the loser no longer performs the export and then loses a
// race for the receipt, it never calls the sink at all.
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

function record(): ScorecardRecord {
  return {
    id: SCORECARD_ID,
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "succeeded",
    scorecard: { suiteId: "d", harness: "h@1", results },
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:01.000Z",
  } as unknown as ScorecardRecord;
}

// The record store is no longer where the publication fence lives (that moved to the operation ledger), so
// this fake only has to answer reads and take the export receipt.
function fakeStore(initial: ScorecardRecord): { store: ScorecardStore; current: () => ScorecardRecord } {
  let held = initial;
  const store = {
    async update(id: string, patch: Partial<ScorecardRecord>) {
      if (id !== held.id) return undefined;
      held = { ...held, ...patch };
      return held;
    },
    async get() {
      return held;
    },
    async list() {
      return [held];
    },
  } as unknown as ScorecardStore;
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

// `planPublicationOperation` answers `undefined` for a settlement that owes nothing outward; every case here
// plans a real debt, so an absent operation is a broken fixture rather than a case to branch on.
function mustPlan(operation: PublicationOperation | undefined): PublicationOperation {
  if (!operation) throw new Error("fixture planned no publication");
  return operation;
}

const plan = (over: Partial<Parameters<typeof planPublicationOperation>[0]> = {}): PublicationOperation =>
  mustPlan(
    planPublicationOperation({
      scorecardId: SCORECARD_ID,
      scoringRevision: 1,
      bundle,
      staged: {
        revisionKey: analysisPassKey(SCORECARD_ID, PASS_ID),
        // Unfrozen by default: these cases hand the drain the plane it counted, which is the path an
        // unfrozen payload takes (compare, then export). The frozen path has its own cases below.
        payload: { kind: "unfrozen", reason: "not the subject of this file" },
      } as never,
      passId: PASS_ID,
      exports: true,
      results,
      now: "2026-08-15T00:00:01.000Z",
      ...over,
    }),
  );

const exportReceipt: ScorecardExport = {
  sink: "mlflow",
  status: "succeeded",
  exportedAt: "2026-08-15T00:00:02.000Z",
  cases: [{ caseId: "c1", externalId: "tr-1" }],
};

const now = (): string => "2026-08-15T00:00:03.000Z";

describe("the publication outbox", () => {
  it("publishes a committed operation exactly once, however many publishers drain it", async () => {
    const operation = plan();
    const operations = new InMemoryPublicationOperationStore();
    await operations.open(operation);
    const { store, current } = fakeStore(record());
    const { artifacts, puts } = fakeArtifacts({ [analysisPassKey(SCORECARD_ID, PASS_ID)]: bundle });
    const exports: string[] = [];
    const deps = {
      store,
      artifacts,
      operations,
      exportResults: async (): Promise<ScorecardExport> => {
        exports.push(SCORECARD_ID);
        return exportReceipt;
      },
    };

    // When the winner drains it inline and the reconciler sweeps immediately afterwards.
    const first = await drainPublicationOperation(deps, record(), operation, results, "winner", now);
    const coordinator = new PublicationCoordinator({
      ...deps,
      getRecord: async () => current(),
      publisherId: "sweep",
      now,
    });
    const swept = await coordinator.reconcile();

    // Then exactly one of them published: one export left the building, one receipt is on the record.
    expect(first.kind).toBe("published");
    expect(exports).toEqual([SCORECARD_ID]);
    expect(swept).toBe(0); // the sweep found nothing owed — the operation is no longer claimable
    // …carrying the settlement it belongs to (arch-review 56, Wave F): the receipt states its own revision so
    // the projection's monotonicity is a property of the stored value rather than a second read of the ledger.
    expect(current().export).toEqual({ ...exportReceipt, scoringRevision: 1 });
    expect((await operations.listForScorecard(SCORECARD_ID))[0]?.state).toBe("published");
    // …and NOTHING was written to object storage. The alias promotion that used to be the second owed effect
    // is deleted (arch-review 55, Wave 7): it wrote a key the settle had already made unreachable, and it was
    // the one effect whose monotonicity no guard here could enforce.
    expect(puts).toEqual([]);
  });

  // RE-POINTED AT THE EXPORT (arch-review 55, Wave 7). This pinned the digest guard on the ARTIFACT effect's
  // staged object; that effect is gone, and the same property lives on the export's frozen payload. It is not
  // a duplicate of the test below it: this one is "the immutable object under my key is not mine", that one
  // is "the LIVE results I was handed are not the ones I counted". Both must refuse; only one is retryable.
  it("an operation whose frozen payload is not the one it planned exports nothing and closes unverifiable", async () => {
    const payloadKey = `payloads/${SCORECARD_ID}/${PASS_ID}.json`;
    const operation = plan({ staged: { payload: { kind: "frozen", key: payloadKey } } as never });
    const operations = new InMemoryPublicationOperationStore();
    await operations.open(operation);
    const { store } = fakeStore(record());
    // The object under this settlement's key holds ANOTHER plane's results.
    const { artifacts, puts } = fakeArtifacts({ [payloadKey]: [{ ...results[0], scores: [] }] });
    const exports: string[] = [];

    const outcome = await drainPublicationOperation(
      {
        store,
        artifacts,
        operations,
        exportResults: async (): Promise<ScorecardExport> => {
          exports.push(SCORECARD_ID);
          return exportReceipt;
        },
      },
      record(),
      operation,
      results,
      "winner",
      () => "2026-08-15T00:00:04.000Z",
    );

    // Then nothing left the building, and the operation does not sit owed forever pretending a retry could
    // fix it: the bytes under that key are not this settlement's, and no sweep changes that.
    expect(exports).toEqual([]);
    expect(puts).toEqual([]);
    expect(outcome.kind).toBe("owed");
    const held = (await operations.listForScorecard(SCORECARD_ID))[0];
    expect(held?.state).toBe("unverifiable");
    expect(held?.lastError).toContain("does not digest");
  });

  it("does not export a plane the settlement never counted", async () => {
    // Given an operation whose payload digest is the results the settle counted, and a drain handed a
    // DIFFERENT plane (a re-score landed in the crash window). Exporting the newer bytes under the older
    // settlement's receipt is the substitution this whole seam exists to prevent.
    const operation = plan({ staged: { payload: { kind: "unfrozen", reason: "no store wired" } } as never });
    expect(operation.effects.find((e) => e.kind === "export")?.payloadDigest).toBe(contentDigest(results));
    const operations = new InMemoryPublicationOperationStore();
    await operations.open(operation);
    const { store } = fakeStore(record());
    const exports: string[] = [];
    const rescored: CaseResult[] = [{ ...results[0], scores: [] } as CaseResult];

    const outcome = await drainPublicationOperation(
      {
        store,
        operations,
        exportResults: async (): Promise<ScorecardExport> => {
          exports.push(SCORECARD_ID);
          return exportReceipt;
        },
      },
      record(),
      operation,
      rescored,
      "winner",
      () => "2026-08-15T00:00:04.000Z",
    );

    expect(exports).toEqual([]);
    expect(outcome.kind).toBe("owed");
    expect((await operations.listForScorecard(SCORECARD_ID))[0]?.state).toBe("unverifiable");
  });

  it("the reconciler drains an operation the winner's process never got to", async () => {
    // Given a settlement that committed and a publisher that died before draining — the crash window the
    // whole ledger exists for.
    const operation = plan();
    const operations = new InMemoryPublicationOperationStore();
    await operations.open(operation);
    const { store, current } = fakeStore(record());
    const { artifacts, puts } = fakeArtifacts({ [analysisPassKey(SCORECARD_ID, PASS_ID)]: bundle });
    const exports: string[] = [];
    const coordinator = new PublicationCoordinator({
      store,
      artifacts,
      operations,
      exportResults: async (): Promise<ScorecardExport> => {
        exports.push(SCORECARD_ID);
        return exportReceipt;
      },
      getRecord: async () => current(),
      publisherId: "sweep",
      now: () => "2026-08-15T00:00:09.000Z",
    });

    expect(await coordinator.reconcile()).toBe(1);
    expect(exports).toEqual([SCORECARD_ID]);
    expect(puts).toEqual([]); // the alias promotion is gone — the export is the whole debt
    expect((await operations.listForScorecard(SCORECARD_ID))[0]?.state).toBe("published");
  });
});
