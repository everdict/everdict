import type { CaseCommitReceipt, CaseResult, Dataset, EvalCase, RunRecord, ScorecardRecord } from "@everdict/contracts";
import { caseResultDigest, initialScoringPassId, judgeEvidenceEmitter } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { ScoringService } from "../execution/scoring-service.js";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { CaseReceiptStore } from "../ports/case-receipt-store.js";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import type { RunStore } from "../ports/run-store.js";
import type { ScorecardStore, ScorecardUpdateGuard } from "../ports/scorecard-store.js";
import type { BatchDriverShared } from "./batch-driver-shared.js";
import type { ScorecardBatchDeps } from "./scorecard-deps.js";
import { WorkflowBatchDriver } from "./workflow-batch-driver.js";

// ── A RECEIPT EXISTS TO BE JOINED (arch-review 55, Wave 4) ───────────────────────────────────────────
//
// Review 53 fixed WHICH judge a receipt names (the family, not the metric suffix) and review 52 made the
// vector state its coverage. Both are properties of the receipt SET. Neither asks the question a receipt is
// for: does the evidence plane it points at exist?
//
// On the Temporal lane it does not. The case activity judges with a scope carrying the physical attempt's
// generation — `{ passId, claim: { generation, attempt: 1 } }` — so the judge's own execution seals as
// `judge:<id>#initial:<sc>.<gen>.1`. That ordinal is the whole point: the activity carries
// `retry: { maximumAttempts: 10 }`, so a worker death re-runs the case and judges it AGAIN, and the ordinal
// is what tells invocation 2's evidence from invocation 1's.
//
// The batch finalizer then REBUILDS the vector from the score plane:
//
//     judgments: judgmentReceiptsFromPlane(results, initialScoringPassId(id)),
//
// with no claim — and its comment states the reasoning that makes this a protocol defect rather than an
// oversight: "the per-case claims are not reachable from here (the activity that judged has returned)". They
// are. The finalizer is holding `committed`, and a commit receipt names the physical attempt it vouches for
// (`attemptId`/`generation`) precisely so a replay reader can answer this question. The claim was re-derived
// from what was convenient instead of carried from where it was born (L3).
//
// So every receipt this lane writes names `judge:<id>#initial:<sc>` — a plane nothing ever sealed. The
// coverage check cannot see it: it counts (case, judge) units, and a count is not a join. `complete` reads
// true while every emitter in the vector points at nothing.

const CASE_ID = "c1";
const SCORECARD_ID = "sc-1";
const CHILD_ID = "child-c1";
const JUDGE_ID = "j1";
// The attempt the case actually ran as. `#g2` and not `#g1`: a re-run opened a second ledger row, which is
// exactly the world the ordinal exists for — and the world in which a receipt naming the bare pass is
// ambiguous between two physical judgments rather than merely imprecise.
const ATTEMPT_ID = `evd-${SCORECARD_ID}-${CASE_ID}#g2`;

const caseResult: CaseResult = {
  caseId: CASE_ID,
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "done" },
  scores: [{ graderId: JUDGE_ID, metric: `judge:${JUDGE_ID}`, value: 1, pass: true }],
};

const child: RunRecord = {
  id: CHILD_ID,
  tenant: "acme",
  harness: { id: "h", version: "1" },
  caseId: CASE_ID,
  status: "succeeded",
  result: caseResult,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:01.000Z",
} as unknown as RunRecord;

// The ledger row the finalizer already holds — and the ONE place the invocation's ordinal survives the
// activity's return.
const receipt: CaseCommitReceipt = {
  scorecardId: SCORECARD_ID,
  caseId: CASE_ID,
  trial: 0,
  kind: "executed",
  childRunId: CHILD_ID,
  executionId: `evd-${SCORECARD_ID}-${CASE_ID}`,
  generation: 2,
  attemptId: ATTEMPT_ID,
  resultDigest: caseResultDigest(caseResult),
  committedAt: "2026-08-18T00:00:01.000Z",
};

const openRecord: ScorecardRecord = {
  id: SCORECARD_ID,
  tenant: "acme",
  dataset: { id: "d", version: "1.0.0" },
  harness: { id: "h", version: "1" },
  status: "running",
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  orchestration: { judges: [{ id: JUDGE_ID, version: "1" }], retries: 0, concurrency: 1 },
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

// A finalize whose settle WINS, so the revision it appends is the one the record keeps.
function harness(): { driver: WorkflowBatchDriver; settled: () => Partial<ScorecardRecord> | undefined } {
  let settled: Partial<ScorecardRecord> | undefined;

  const artifacts: ArtifactStore = {
    async put(key) {
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
    async update(_id: string, patch: Partial<ScorecardRecord>, _events, guard?: ScorecardUpdateGuard) {
      if (guard?.expectNonTerminal === true) settled = patch;
      return { ...openRecord, ...patch };
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

  const deps: ScorecardBatchDeps = {
    dispatcher: {
      async dispatch() {
        throw new Error("unused");
      },
    },
    store,
    datasets: unusedDatasets,
    runStore: {
      async list() {
        return [child];
      },
    } as unknown as RunStore,
    caseReceipts: {
      async list() {
        return [receipt];
      },
      async listResult() {
        return { kind: "read", value: [receipt] };
      },
    } as unknown as CaseReceiptStore,
    artifacts,
  };

  const shared = {
    newId: () => "id-1",
    now: () => "2026-08-18T00:00:02.000Z",
    scoring: new ScoringService({}),
    inFlight: new Map<string, AbortController>(),
    async checkReceiptParity() {
      /* not the subject */
    },
  } as unknown as BatchDriverShared;

  const driver = new WorkflowBatchDriver(deps, shared);
  const ctx: InjectableContext = {
    tenant: "acme",
    owner: "acme",
    dataset: { id: "d", version: "1.0.0", cases: [{ id: CASE_ID, prompt: "p" }] } as unknown as Dataset,
    harnessId: "h",
    harnessVersion: "1",
    judges: [{ id: JUDGE_ID, version: "1" }],
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

  return { driver, settled: () => settled };
}

// RED as of b9cde092, observed:
//   expected [ 'judge:j1#initial:sc-1' ] to deeply equal [ 'judge:j1#initial:sc-1.2.1' ]
describe("[R55 WAVE-4 COUNTEREXAMPLE #4 — CLOSED] a judgment receipt names the plane its invocation sealed", () => {
  it("carries the committed attempt's ordinal, not the bare pass id", async () => {
    const { driver, settled } = harness();

    await driver.finalizeBatch(SCORECARD_ID);

    const revision = settled()?.scoring?.at(-1);
    // A vector that came back empty would accept every assertion below (rule `testing`, the vacuous-fixture
    // rule) — so its cardinality is asserted before its contents.
    expect(revision?.judgments, "no receipt vector was written at all").toHaveLength(1);
    expect(
      revision?.judgments?.map((r) => r.evidenceEmitter),
      "the receipt names a plane nothing sealed — the invocation's ordinal was dropped at the finalize",
    ).toEqual([
      judgeEvidenceEmitter(JUDGE_ID, {
        passId: initialScoringPassId(SCORECARD_ID),
        claim: { generation: 2, attempt: 1 },
      }),
    ]);
  });

  it("says NOTHING rather than inventing an ordinal when the receipt has no attempt", async () => {
    // The other direction, and the reason the claim cannot simply be defaulted: an unisolated attempt has a
    // ledger row and no recording generation, and the judging site says so by passing no claim. A finalize
    // that fabricated `.0.1` here would break the join just as thoroughly — which is what
    // `identity-sentinel-guard` refuses everywhere else in this codebase.
    const { driver, settled } = harness();
    const bare: CaseCommitReceipt = { ...receipt };
    // biome-ignore lint/performance/noDelete: modelling a legacy row that never recorded an attempt
    delete (bare as { attemptId?: string }).attemptId;
    // biome-ignore lint/performance/noDelete: …and no generation either — the two travel together
    delete (bare as { generation?: number }).generation;
    (
      driver as unknown as { deps: { caseReceipts: { list: () => Promise<CaseCommitReceipt[]> } } }
    ).deps.caseReceipts.list = async () => [bare];

    await driver.finalizeBatch(SCORECARD_ID);

    const revision = settled()?.scoring?.at(-1);
    expect(revision?.judgments).toHaveLength(1);
    expect(revision?.judgments?.map((r) => r.evidenceEmitter)).toEqual([
      judgeEvidenceEmitter(JUDGE_ID, { passId: initialScoringPassId(SCORECARD_ID) }),
    ]);
  });
});
