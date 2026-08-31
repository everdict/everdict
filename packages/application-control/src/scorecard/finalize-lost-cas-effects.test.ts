import type {
  CaseCommitReceipt,
  CaseResult,
  Dataset,
  EvalCase,
  RunRecord,
  ScorecardExport,
  ScorecardRecord,
} from "@everdict/contracts";
import { caseResultDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { ScoringService } from "../execution/scoring-service.js";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { CaseReceiptStore } from "../ports/case-receipt-store.js";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import { InMemoryPublicationOperationStore } from "../ports/publication-operation-store.js";
import type { RunStore } from "../ports/run-store.js";
import type { ScorecardStore, ScorecardUpdateGuard } from "../ports/scorecard-store.js";
import type { BatchDriverShared } from "./batch-driver-shared.js";
import type { ScorecardBatchDeps } from "./scorecard-deps.js";
import { ScorecardScoreService } from "./scorecard-score-service.js";
import { WorkflowBatchDriver } from "./workflow-batch-driver.js";

// ── A FINALIZER THAT LOST THE SETTLE MUST NOT HAVE PUBLISHED ─────────────────────────────────────────
//
// `finalizeBatch` already knows the rule and states it twice: the terminal write is read-guarded and epoch-
// fenced (`settleScorecard(… { over: "open", epoch })`), and when it comes back `undefined` the attempt
// publishes nothing — no facts, no metrics, no notification, "the winner publishes, counts and notifies; this
// attempt does none of the three".
//
// Two effects escape that rule, because they happen BEFORE the fence rather than after it:
//
//   1. `offloadAnalysis(this.deps, id, initialBundle, initialPassId(...))` writes the MUTABLE current key
//      (`analyses/<id>.json`) — the object `ScorecardRecord.analysisRef` points at and the analysis surface
//      re-reads. The per-pass frozen key is pass-scoped precisely so two finalizers cannot collide on it
//      (review 39 P0-6); the current key has no such protection and is overwritten unconditionally.
//   2. `exportResults(...)` ships the batch's cases to the tenant's observability platform. An export is not
//      a local write: it creates traces in someone else's system, and no later CAS result can recall them.
//
// So a Temporal activity that paused between its read and its settle — the ordinary at-least-once shape this
// whole file is built around — republishes the current analysis artifact of a batch that a user CANCELLED
// while it slept, and exports the cases of a batch that will never be reported as succeeded. The record ends
// up cancelled while the artifact behind `analysisRef` and the rows in the tenant's MLflow describe a
// successful run. Every guard in the file holds; the effects simply ran on the wrong side of it.
//
// The fix this pins is ordering, not another check: the settlement's outward effects hang off the settlement
// that COMMITTED (the wave-4 publication outbox), so there is no window in which they can be performed by an
// attempt that has not yet won.
const CASE_ID = "c1";
const SCORECARD_ID = "sc-1";
const CHILD_ID = "child-c1";
const ANALYSIS_CURRENT_KEY = `analyses/${SCORECARD_ID}.json`;

const caseResult: CaseResult = {
  caseId: CASE_ID,
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "done" },
  scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
};

const child: RunRecord = {
  id: CHILD_ID,
  tenant: "acme",
  harness: { id: "h", version: "1" },
  caseId: CASE_ID,
  status: "succeeded",
  result: caseResult,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:01.000Z",
} as unknown as RunRecord;

const receipt: CaseCommitReceipt = {
  scorecardId: SCORECARD_ID,
  caseId: CASE_ID,
  trial: 0,
  kind: "executed",
  childRunId: CHILD_ID,
  resultDigest: caseResultDigest(caseResult),
  committedAt: "2026-08-15T00:00:01.000Z",
};

// The record as the finalizer READS it: still open, so the `isTerminal()` early-out lets it through. The
// concurrent cancel commits after this read — which the store below models by refusing the fenced write.
const openRecord: ScorecardRecord = {
  id: SCORECARD_ID,
  tenant: "acme",
  dataset: { id: "d", version: "1.0.0" },
  harness: { id: "h", version: "1" },
  status: "running",
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
  orchestration: { judges: [], retries: 0, concurrency: 1 },
} as unknown as ScorecardRecord;

const unusedDatasets: DatasetRegistry = {
  // Ownership is not a question these cores ask. Throwing rather than answering `undefined` keeps the double
  // from silently supplying the permissive arm of a gate it does not model (arch-review 119).
  async teamOfVersion(): Promise<string | undefined> {
    throw new Error("unused");
  },
  async register() {
    throw new Error("unused");
  },
  async has() {
    return false;
  },
  async get(): Promise<Dataset> {
    throw new Error("unused");
  },
  async versions() {
    return [];
  },
  async ownVersions() {
    return [];
  },
  async list() {
    return [];
  },
  async creatorOf() {
    return undefined;
  },
  async moveToTeam() {
    throw new Error("unused");
  },
  async softDelete() {
    throw new Error("unused");
  },
  async setVersionTags() {
    throw new Error("unused");
  },
  async versionTags() {
    return {};
  },
};

// The private per-batch context, injected directly: `buildBatchContext` re-resolves registries and verifies
// the sealed plan, none of which is the subject here — the subject is the ORDER of three statements inside
// `finalizeBatch`.
type InjectableContext = {
  tenant: string;
  owner: string;
  dataset: Dataset;
  harnessId: string;
  harnessVersion: string;
  judges: Array<{ id: string; version: string }>;
  retries: number;
  concurrency: number;
  caseIndex: Map<string, EvalCase>;
  targets: string[];
  driverEpoch: number;
  doneIds: Set<string>;
  inFlightIds: Set<string>;
  stepChain: Promise<void>;
};

function harness(): { driver: WorkflowBatchDriver; putKeys: string[]; exports: string[] } {
  const putKeys: string[] = [];
  const exports: string[] = [];

  const artifacts: ArtifactStore = {
    async put(key) {
      putKeys.push(key);
      return `https://artifacts.invalid/${key}`;
    },
    async get() {
      return undefined;
    },
    async publicUrlFor() {
      return undefined;
    },
  };

  const store: ScorecardStore = {
    async create() {
      throw new Error("unused");
    },
    // A GUARDED write is the settle; it LOSES, because a user cancel committed between this finalizer's read
    // and its terminal write. An unguarded write is the step-timeline append, which is not the subject.
    async update(_id: string, _patch: Partial<ScorecardRecord>, _events, guard?: ScorecardUpdateGuard) {
      if (guard?.expectNonTerminal === true) return undefined;
      return openRecord;
    },
    async get() {
      return openRecord;
    },
    async list() {
      return [];
    },
    // No rows, so no groups — the same answer its `list` gives, in the shape a GROUP BY has.
    async countByGroup() {
      return [];
    },
    async delete() {
      return false;
    },
  };

  const runStore = {
    async list() {
      return [child];
    },
  } as unknown as RunStore;

  const caseReceipts = {
    async list() {
      return [receipt];
    },
  } as unknown as CaseReceiptStore;

  const deps: ScorecardBatchDeps = {
    dispatcher: {
      async dispatch() {
        throw new Error("unused");
      },
    },
    store,
    datasets: unusedDatasets,
    runStore,
    caseReceipts,
    artifacts,
    async exportResults(_tenant, ctx): Promise<ScorecardExport | undefined> {
      exports.push(ctx.scorecardId);
      return { status: "ok" } as unknown as ScorecardExport;
    },
  };

  const shared = {
    newId: () => "id-1",
    now: () => "2026-08-15T00:00:02.000Z",
    scoring: new ScoringService({}),
    inFlight: new Map<string, AbortController>(),
    async checkReceiptParity() {
      /* the ledger↔receipt parity note; not the subject */
    },
  } as unknown as BatchDriverShared;

  const driver = new WorkflowBatchDriver(deps, shared);
  const ctx: InjectableContext = {
    tenant: "acme",
    owner: "acme",
    dataset: { id: "d", version: "1.0.0", cases: [{ id: CASE_ID, prompt: "p" }] } as unknown as Dataset,
    harnessId: "h",
    harnessVersion: "1",
    judges: [],
    retries: 0,
    concurrency: 1,
    caseIndex: new Map<string, EvalCase>([[CASE_ID, { id: CASE_ID, prompt: "p" } as unknown as EvalCase]]),
    targets: [],
    driverEpoch: 0,
    doneIds: new Set<string>([CASE_ID]),
    inFlightIds: new Set<string>(),
    stepChain: Promise.resolve(),
  };
  (driver as unknown as { batchContexts: Map<string, InjectableContext> }).batchContexts.set(SCORECARD_ID, ctx);

  return { driver, putKeys, exports };
}

describe("a Temporal finalize that loses the terminal CAS", () => {
  // [WAVE-4 COUNTEREXAMPLE #12] GREEN since the publication outbox landed. It was RED as of 02a3e15e:
  // `AssertionError: expected [ 'analyses/sc-1.json', …(1) ] to not include 'analyses/sc-1.json'` (and, with
  // that line removed, `expected [ 'sc-1' ] to deeply equal []` — BOTH effects fired), because
  // `offloadAnalysis` and `exportResults` ran BEFORE the `settleScorecard` fence. The finalize now STAGES the
  // bundle under its content-addressed pass key, plans the two outward effects onto the terminal patch, and
  // drains them only once that write has matched a row.
  it("leaves the mutable analysis artifact and the tenant's trace sink untouched", async () => {
    // Given a finalizer whose read saw an OPEN batch and whose terminal write will be refused, because a
    // cancel committed in between — the at-least-once shape this driver is built around.
    const { driver, putKeys, exports } = harness();

    await driver.finalizeBatch(SCORECARD_ID);

    // Then it published nothing outward. The mutable key is what `analysisRef` resolves to, so rewriting it
    // makes a cancelled batch's analysis surface describe a successful run…
    expect(putKeys).not.toContain(ANALYSIS_CURRENT_KEY);
    // …and an export cannot be taken back: the traces live in the tenant's platform from the moment it runs.
    expect(exports).toEqual([]);
  });
});

// ── …AND NEITHER MAY A RE-SCORE THAT LOST THE LEDGER CAS (arch-review 52, wave 5) ────────────────────
//
// The driver's finalize was converted first; `ScorecardScoreService.aggregate` is the same statement order
// one plane up, and it was the last pre-CAS mutable-alias write in the codebase. Its guarded settle refuses a
// pass whose ledger moved underneath it — a stale takeover's original waking late, which this service treats
// as the ordinary shape and answers with a `ConflictError`. `offloadAnalysis` ran before that refusal, so the
// losing pass had already replaced `analyses/<id>.json` with a bundle describing a revision it never
// appended: the record's ledger names the winner's judgment while the artifact behind `analysisRef`
// describes the loser's.
function rescoreHarness(opts: { refuseSettle: boolean }): {
  svc: ScorecardScoreService;
  putKeys: string[];
  objects: Map<string, Buffer>;
} {
  const putKeys: string[] = [];
  // The publication ledger this world's settle inserts into and its drain claims from (arch-review 53, Wave C).
  const publications = new InMemoryPublicationOperationStore();
  // A REAL artifact store — the alias promotion is a read-then-put of the staged object, so a store whose
  // `get` answers nothing would report the promotion as owed and make the winning half of this vacuous.
  const objects = new Map<string, Buffer>();
  const artifacts: ArtifactStore = {
    async put(key, body) {
      putKeys.push(key);
      objects.set(key, Buffer.from(body));
      return `https://artifacts.invalid/${key}`;
    },
    async get(key) {
      return objects.get(key);
    },
    async publicUrlFor() {
      return undefined;
    },
  };
  let patched: Partial<ScorecardRecord> = {};
  const scored: ScorecardRecord = {
    id: SCORECARD_ID,
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "succeeded",
    runIds: [CHILD_ID],
    scorecard: { suiteId: "d", harness: "h@1", results: [caseResult] },
    scoringPass: {
      passId: "pass-1",
      epoch: 1,
      leaseUntil: "2026-08-15T00:05:00.000Z",
      heartbeatAt: "2026-08-15T00:00:00.000Z",
      targetRevision: 1,
      baseRevision: 0,
      judges: [],
      startedAt: "2026-08-15T00:00:00.000Z",
      status: "running",
    },
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  } as unknown as ScorecardRecord;
  const current = (): ScorecardRecord => ({ ...scored, ...patched }) as ScorecardRecord;
  const store: ScorecardStore = {
    async create() {
      throw new Error("unused");
    },
    // The GUARDED settle is the one write carrying `expectScoringCount`; refusing it is what a concurrent
    // pass settling first looks like from in here.
    async update(_id, patch, _events, guard?: ScorecardUpdateGuard) {
      if (opts.refuseSettle && guard?.expectScoringCount !== undefined) return undefined;
      patched = { ...patched, ...patch };
      // The settlement's owed publication is inserted BY THIS WRITE in both real stores (arch-review 53,
      // Wave C — the Pg CTE and the in-memory attach pair). A fake that dropped it would make every drain
      // below a no-op and the test vacuous.
      if (guard?.publishOperation !== undefined) void publications.open(guard.publishOperation);
      return current();
    },
    async get() {
      return current();
    },
    async list() {
      return [];
    },
    // No rows, so no groups — the same answer its `list` gives, in the shape a GROUP BY has.
    async countByGroup() {
      return [];
    },
    async delete() {
      return false;
    },
  };
  const runStore = {
    async list() {
      return [child];
    },
    async update() {
      return child;
    },
  } as unknown as RunStore;
  const svc = new ScorecardScoreService(
    {
      store,
      datasets: unusedDatasets,
      artifacts,
      runStore,
      // The publication ledger the re-score's settle inserts its operation into (arch-review 53, Wave C) —
      // without it the drain has nothing to claim and the alias promotion this test is about never runs.
      publicationOperations: publications,
      publisherId: "test-publisher",
    },
    {
      newId: () => "id-1",
      now: () => "2026-08-15T00:00:02.000Z",
      scoring: new ScoringService({}),
      getRecord: async () => current(),
      pinJudges: async (_tenant, refs) => refs,
    },
  );
  return { svc, putKeys, objects };
}

describe("a re-score settle that loses the ledger CAS", () => {
  it("stages its analysis bundle under the pass key and leaves the mutable alias to the pass that wins", async () => {
    const { svc, putKeys } = rescoreHarness({ refuseSettle: true });

    await expect(svc.finalizeScore(SCORECARD_ID, [], undefined, "pass-1")).rejects.toThrow(
      /another scoring pass settled this group first/,
    );

    // The immutable, content-addressed object IS written before the CAS — that is safe by construction: a
    // loser's object is an orphan nobody references, and asserting it here keeps the next line honest rather
    // than vacuously true because nothing was written at all.
    expect(putKeys.some((k) => k.startsWith(`analyses/${SCORECARD_ID}/passes/`))).toBe(true);
    // …and the MUTABLE alias — what `analysisRef` resolves to and the analysis surface re-reads — is not.
    expect(putKeys).not.toContain(ANALYSIS_CURRENT_KEY);
  });

  // RESTATED (arch-review 55, Wave 7). It read "promotes the alias once its settle has committed, from the
  // very object its revision points at" — true while the alias promotion existed, and the promotion is gone:
  // it wrote an object the settle had already made unreachable (the revision's own pass-scoped `analysisKey`
  // is what the analysis reader resolves first). The property that MATTERS here is the one this file is about
  // and it survives unchanged: the pass-scoped object is staged, and the mutable key is never touched at all.
  it("stages its own pass-scoped object and writes no mutable key, won or lost", async () => {
    const { svc, putKeys, objects } = rescoreHarness({ refuseSettle: false });

    await svc.finalizeScore(SCORECARD_ID, [], undefined, "pass-1");

    const staged = putKeys.find((k) => k.startsWith(`analyses/${SCORECARD_ID}/passes/`));
    expect(staged, "the pass's frozen artifact was not staged").toBeDefined();
    expect(objects.get(staged ?? "")).toBeDefined();
    // The alias is not a thing this settlement can move any more — winning does not license it either.
    expect(putKeys).not.toContain(ANALYSIS_CURRENT_KEY);
  });
});
