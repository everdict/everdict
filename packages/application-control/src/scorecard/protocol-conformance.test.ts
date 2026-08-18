import type { CaseResult, ScorecardExport, ScorecardRecord } from "@everdict/contracts";
import { runDurableTeardown } from "../cancellation/cancellation-coordinator.js";
import { describeCancellationVerification, describePublicationOperation } from "../conformance/index.js";
import type { CancellationCertificate, CancellationStore, CancellationTarget } from "../ports/cancellation-store.js";
import { InMemoryPublicationOperationStore } from "../ports/publication-operation-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { drainPublicationOperation, planPublicationOperation } from "./publication.js";
import type { AnalysisBundle } from "./scorecard-observability.js";

// ── THE CONTROL-PLANE PROTOCOLS RUN THE SAME SUITE (arch-review 53, Wave F) ─────────────────────────
//
// The two suites the placement layer cannot host, because their subjects live here: the publication ledger
// and the cancellation operation. Same shape as the backend suites — a function over an implementation — so a
// second implementation of either port is certified by calling them rather than by remembering to re-derive
// the questions.

const SCORECARD_ID = "sc-conf";
const NOW = "2026-08-17T00:00:00.000Z";
// The lease timeline: a claim at T0 for 60s, still working at T+90s.
const LEASE_T0 = "2026-08-17T00:00:00.000Z";
const LEASE_T90 = "2026-08-17T00:01:30.000Z";

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

const record = (): ScorecardRecord =>
  ({
    id: SCORECARD_ID,
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "succeeded",
    scorecard: { suiteId: "d", harness: "h@1", results },
    createdAt: NOW,
    updatedAt: NOW,
  }) as unknown as ScorecardRecord;

const store = {
  async update() {
    return record();
  },
  async get() {
    return record();
  },
  async list() {
    return [record()];
  },
} as unknown as ScorecardStore;

// Export-only operations: the alias promotion needs an artifact store, and an unwired one would leave every
// operation owed for a reason that has nothing to do with the protocols under test.
const operationFor = (passId: string, revision: number) => {
  const planned = planPublicationOperation({
    scorecardId: SCORECARD_ID,
    scoringRevision: revision,
    bundle,
    staged: { payload: { kind: "unfrozen", reason: "not the subject of this suite" } } as never,
    passId,
    exports: true,
    results,
    now: NOW,
  });
  if (!planned) throw new Error("this settlement owes an export");
  return planned;
};

describePublicationOperation("InMemoryPublicationOperationStore", () => ({
  drainTwice: async () => {
    const operations = new InMemoryPublicationOperationStore();
    const operation = operationFor("initial-abc", 1);
    await operations.open(operation);
    let calls = 0;
    const exportResults = async (): Promise<ScorecardExport> => {
      calls += 1;
      return { status: "succeeded", sink: "mlflow", exportedAt: NOW } as ScorecardExport;
    };
    await Promise.all([
      drainPublicationOperation({ store, exportResults, operations }, record(), operation, results, "a", () => NOW),
      drainPublicationOperation({ store, exportResults, operations }, record(), operation, results, "b", () => NOW),
    ]);
    return calls;
  },
  owedAfterTwoSettlements: async () => {
    const operations = new InMemoryPublicationOperationStore();
    await operations.open(operationFor("initial-abc", 1));
    await operations.open(operationFor("rescore-def", 2));
    return (await operations.listForScorecard(SCORECARD_ID)).map((o) => o.id);
  },
  owedAfterRenewalPastLease: async () => {
    const operations = new InMemoryPublicationOperationStore();
    const operation = operationFor("initial-abc", 1);
    await operations.open(operation);
    await operations.claim(operation.id, "a", 60, LEASE_T0);
    // The drain is still uploading when the original lease would have run out; the heartbeat moves it.
    await operations.renew(operation.id, "a", 60, LEASE_T90);
    return (await operations.listOwed(10, LEASE_T90)).length;
  },
  renewalByAnotherOwner: async () => {
    const operations = new InMemoryPublicationOperationStore();
    const operation = operationFor("initial-abc", 1);
    await operations.open(operation);
    await operations.claim(operation.id, "a", 60, LEASE_T0);
    return await operations.renew(operation.id, "b", 60, LEASE_T90);
  },
}));

const TARGET: CancellationTarget = { kind: "run", id: "r-conf" };

function cancellationLedger(): { store: CancellationStore; stateOf: () => string } {
  let state = "requested";
  return {
    stateOf: () => state,
    store: {
      async request() {},
      async complete() {
        state = "completed";
      },
      async fail(_t: CancellationTarget, _e: string, _n: string, to = "requested") {
        state = to;
      },
      async abandon() {
        state = "unverifiable";
      },
      async get() {
        return { target: TARGET, state: "requested" as const, requestedAt: NOW };
      },
      async listIncomplete() {
        return [];
      },
    } as unknown as CancellationStore,
  };
}

describeCancellationVerification("runDurableTeardown", () => ({
  afterLiveReadback: async () => {
    const { store: ledger, stateOf } = cancellationLedger();
    await runDurableTeardown({ cancellations: ledger, now: () => NOW }, TARGET, async () => {
      throw Object.assign(new Error("1 job still live"), { data: { activeManagedWork: 1, unverifiable: 0 } });
    }).catch(() => undefined);
    return stateOf();
  },
  afterQuietReadback: async () => {
    const { store: ledger, stateOf } = cancellationLedger();
    const certificate: CancellationCertificate = { at: NOW, activeManagedWork: 0, unverifiable: 0 };
    await runDurableTeardown({ cancellations: ledger, now: () => NOW }, TARGET, async () => certificate);
    return stateOf();
  },
}));
