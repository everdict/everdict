import {
  InMemoryCaseReceiptStore,
  InMemoryExecutionAttemptStore,
  type OpenAttemptInput,
  ScorecardService,
} from "@everdict/application-control";
import {
  BadRequestError,
  type CaseJob,
  type CaseResult,
  type ExecutionAttemptState,
  UpstreamError,
} from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
} from "@everdict/registry";
import { describe, expect, it } from "vitest";

// ── EVERY PHYSICAL EXECUTION LEAVES A ROW (arch-review 42, Three-Ledger Phase 1) ─────────────────────
//
// The receipt names the attempt that EARNED the case — one per (scorecard, case, trial) by construction, so
// it structurally cannot report the attempts that ran and lost. This certifies the other half: the batch
// lanes open an attempt row per physical execution and stamp its terminal state beside the commit point, so
// a superseded attempt is a row that says `superseded` rather than an absence.

class CaseBoom extends BadRequestError {
  constructor() {
    super("BAD_REQUEST", {}, "case exploded");
  }
}

function serviceWith(
  dispatch: (job: CaseJob) => Promise<CaseResult>,
  // The ledger under test — a fake one lets a test decide what happens at the moment of the terminal stamp.
  ledger?: (receipts: InMemoryCaseReceiptStore) => InMemoryExecutionAttemptStore,
): {
  service: ScorecardService;
  attempts: InMemoryExecutionAttemptStore;
  receipts: InMemoryCaseReceiptStore;
  store: InMemoryScorecardStore;
  runs: InMemoryRunStore;
  datasets: InMemoryDatasetRegistry;
} {
  const receipts = new InMemoryCaseReceiptStore();
  const store = new InMemoryScorecardStore();
  store.attachReceipts((id) => receipts.countFor(id));
  const runs = new InMemoryRunStore();
  runs.attachScorecards(store);
  const datasets = new InMemoryDatasetRegistry();
  const attempts = ledger ? ledger(receipts) : new InMemoryExecutionAttemptStore();
  const service = new ScorecardService({
    dispatcher: { dispatch },
    store,
    runStore: runs,
    datasets,
    caseReceipts: receipts,
    attempts,
    harnesses: new InMemoryHarnessInstanceRegistry(new InMemoryHarnessTemplateRegistry()),
  } as never);
  return { service, attempts, receipts, store, runs, datasets };
}

async function registerDataset(datasets: InMemoryDatasetRegistry, ids: string[]): Promise<void> {
  await datasets.register("acme", {
    id: "d",
    version: "1.0.0",
    tags: [],
    cases: ids.map((id) => ({
      id,
      env: { kind: "prompt" as const },
      task: "t",
      graders: [],
      timeoutSec: 60,
      tags: [],
    })),
  });
}

async function settled(store: InMemoryScorecardStore, id: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rec = await store.get(id);
    if (rec && ["succeeded", "failed", "cancelled", "superseded"].includes(rec.status)) return rec.status;
    if (Date.now() > deadline) throw new Error(`batch ${id} never settled (status ${rec?.status})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("the physical execution ledger records every attempt a batch actually ran", () => {
  it("a pass and a failure each leave a terminal attempt row naming the child it wrote to", async () => {
    // Given a batch with one passing and one failing case
    const { service, attempts, store, datasets } = serviceWith(async (job) => {
      if (job.evalCase.id === "c-fail") throw new CaseBoom();
      return {
        caseId: job.evalCase.id,
        harness: "h@1.0.0",
        trace: [],
        snapshot: { kind: "prompt", output: "" },
        scores: [{ metric: "pass", graderId: "g", value: 1, pass: true }],
      };
    });
    await registerDataset(datasets, ["c-ok", "c-fail"]);

    // When it runs to settlement
    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      retries: 0,
    } as never);
    await settled(store, record.id);

    // Then BOTH executions are on the physical ledger — the failure included, which is the outcome the
    // recording lane could most easily have left no trace of.
    const rows = await attempts.listForScorecard(record.id);
    expect(rows.map((r) => r.caseId).sort()).toEqual(["c-fail", "c-ok"]);
    const ok = rows.find((r) => r.caseId === "c-ok");
    const failed = rows.find((r) => r.caseId === "c-fail");
    // …each stamped with how it ENDED, not merely that it existed.
    expect(ok?.state).toBe("committed");
    expect(failed?.state).toBe("failed");
    expect(failed?.error?.code).toBe("BAD_REQUEST"); // the exit's own code, carried onto the ledger
    // …and each names the child run it wrote to, so the two planes join without a derivation.
    expect(ok?.childRunId).toBeDefined();
    expect(failed?.childRunId).toBeDefined();
    // The first physical execution of a case owns generation 1: generation 0 is what an untold producer
    // stamps, and it must never be a real attempt's coordinate.
    expect(ok?.generation).toBe(1);
    expect(ok?.attemptId).toBe(`${ok?.executionId}#g1`);
    expect(ok?.tenant).toBe("acme");
  });

  it("a retried case leaves TWO attempt rows — the abandoned one superseded, the winner committed", async () => {
    // Given a case whose first dispatch fails retryably and whose second succeeds
    let dispatches = 0;
    const { service, attempts, store, datasets } = serviceWith(async (job) => {
      dispatches += 1;
      if (dispatches === 1) throw new UpstreamError("UPSTREAM_ERROR", {}, "sandbox died");
      return {
        caseId: job.evalCase.id,
        harness: "h@1.0.0",
        trace: [],
        snapshot: { kind: "prompt", output: "" },
        scores: [{ metric: "pass", graderId: "g", value: 1, pass: true }],
      };
    });
    await registerDataset(datasets, ["c1"]);

    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      retries: 1,
    } as never);
    expect(await settled(store, record.id)).toBe("succeeded");

    // Then the ledger holds BOTH physical executions of the one logical case. The batch's receipt says only
    // that c1 passed; the compute the first attempt spent is a fact only this plane records.
    const rows = await attempts.listForScorecard(record.id);
    expect(rows.map((r) => r.generation)).toEqual([1, 2]);
    expect(rows.map((r) => r.state)).toEqual(["superseded", "committed"]);
    // The abandoned attempt carries WHY it stopped being the case's — a supersede, not a failure: the error
    // was not final (this very retry is the proof).
    expect(rows[0]?.error?.code).toBe("UPSTREAM_ERROR");
    // …and both are attempts OF THE SAME execution, which is exactly what the correlation id alone could
    // never tell apart.
    expect(rows[0]?.executionId).toBe(rows[1]?.executionId);
  });

  it("with no ledger wired the batch behaves exactly as before — the plane is additive", async () => {
    // Given the same batch with `attempts` unwired (the pre-ledger deployment)
    const receipts = new InMemoryCaseReceiptStore();
    const store = new InMemoryScorecardStore();
    store.attachReceipts((id) => receipts.countFor(id));
    const runs = new InMemoryRunStore();
    runs.attachScorecards(store);
    const datasets = new InMemoryDatasetRegistry();
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(job: CaseJob): Promise<CaseResult> {
          return {
            caseId: job.evalCase.id,
            harness: "h@1.0.0",
            trace: [],
            snapshot: { kind: "prompt", output: "" },
            scores: [{ metric: "pass", graderId: "g", value: 1, pass: true }],
          };
        },
      },
      store,
      runStore: runs,
      datasets,
      caseReceipts: receipts,
      harnesses: new InMemoryHarnessInstanceRegistry(new InMemoryHarnessTemplateRegistry()),
    } as never);
    await registerDataset(datasets, ["c1"]);

    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      retries: 0,
    } as never);
    expect(await settled(store, record.id)).toBe("succeeded");
    expect(await receipts.list(record.id)).toHaveLength(1);
  });
});

// ── THE TERMINAL STAMP RIDES THE COMMIT (arch-review 43, the promotion out of Phase 1) ────────────────
//
// Phase 1 stamped the attempt AFTER `commitCase` resolved, best-effort: a crash in that window left a
// committed receipt naming an execution whose attempt row still said `created` — a receipt about an attempt
// the physical ledger never saw end. The stamp is now a step of the commit itself, which means two things a
// test can see: it happens while the receipt is still unmade, and a ledger that cannot take it refuses the
// whole commit instead of shrugging.

const passingResult = (job: CaseJob): CaseResult => ({
  caseId: job.evalCase.id,
  harness: "h@1.0.0",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: [{ metric: "pass", graderId: "g", value: 1, pass: true }],
});

// Records what the receipt plane looked like AT the instant of the terminal stamp. The scorecard id comes
// from the attempt's own open — the batch id is not known to the test until submit returns, which is already
// a race with the loop this observes.
class WatchingLedger extends InMemoryExecutionAttemptStore {
  readonly receiptsWhenStamped: number[] = [];
  private scorecardId?: string;

  constructor(private readonly receipts: InMemoryCaseReceiptStore) {
    super();
  }

  override async open(input: OpenAttemptInput): Promise<{ attemptId: string; generation: number }> {
    this.scorecardId ??= input.scorecardId;
    return super.open(input);
  }

  // ⚠️ RE-POINTED AT `adoptAtSettlement` (arch-review 67 P1-high). The ordinary settlement used to reach
  // `committed` through `transition` and drop the boolean; it goes through the semantic adoption now, whose
  // answer aborts the transaction. A double still watching `transition` observes nothing — which is a test
  // that stopped measuring rather than a protocol that stopped holding (rule `testing`: after a refactor,
  // re-prove by mutation).
  override async adoptAtSettlement(
    attemptId: string,
    at: Parameters<InMemoryExecutionAttemptStore["adoptAtSettlement"]>[1],
  ): Promise<ReturnType<InMemoryExecutionAttemptStore["adoptAtSettlement"]> extends Promise<infer R> ? R : never> {
    const scorecardId = this.scorecardId;
    if (scorecardId !== undefined) this.receiptsWhenStamped.push(this.receipts.countFor(scorecardId));
    return super.adoptAtSettlement(attemptId, at);
  }
}

// A ledger that cannot record the terminal state of the very attempt the receipt is about to name.
class BrokenLedger extends InMemoryExecutionAttemptStore {
  override async adoptAtSettlement(
    attemptId: string,
    at: Parameters<InMemoryExecutionAttemptStore["adoptAtSettlement"]>[1],
  ): Promise<ReturnType<InMemoryExecutionAttemptStore["adoptAtSettlement"]> extends Promise<infer R> ? R : never> {
    void attemptId;
    void at;
    throw new UpstreamError("UPSTREAM_ERROR", {}, "attempt ledger down");
  }

  override async transition(
    attemptId: string,
    to: ExecutionAttemptState,
    patch?: Parameters<InMemoryExecutionAttemptStore["transition"]>[2],
  ): Promise<boolean> {
    if (to === "committed") throw new UpstreamError("UPSTREAM_ERROR", {}, "attempt ledger down");
    return super.transition(attemptId, to, patch);
  }
}

describe("a case's terminal attempt stamp is part of its commit, not a note taken afterwards", () => {
  it("stamps the attempt while the receipt is still unmade — the two are one decision", async () => {
    // Given a batch whose ledger records the receipt count at the moment it is stamped
    let watcher: WatchingLedger | undefined;
    const { service, receipts, store, datasets } = serviceWith(
      async (job) => passingResult(job),
      (r) => {
        watcher = new WatchingLedger(r);
        return watcher;
      },
    );
    await registerDataset(datasets, ["c1"]);

    // When the case commits
    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      retries: 0,
    } as never);
    expect(await settled(store, record.id)).toBe("succeeded");

    // Then the stamp happened INSIDE the commit: the receipt this attempt earns was not yet persisted when
    // the ledger was written. Stamped afterwards — the Phase-1 shape — the count here would read 1.
    expect(watcher?.receiptsWhenStamped).toEqual([0]);
    expect(await receipts.list(record.id)).toHaveLength(1);
  });

  it("REFUSES the commit when the ledger cannot take the stamp — no receipt for an execution it never saw end", async () => {
    // Given a ledger that throws on the terminal transition
    const { service, receipts, store, datasets } = serviceWith(
      async (job) => passingResult(job),
      () => new BrokenLedger(),
    );
    await registerDataset(datasets, ["c1"]);

    // When the batch runs, the commit cannot complete — and the batch refuses to summarize a case no reader
    // will find on the ledger (the same answer any other store fault at the commit point gets).
    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      retries: 0,
    } as never);
    expect(await settled(store, record.id)).toBe("failed");

    // Then NO receipt was made: the claim is un-happened, so the case is still claimable by a re-drive.
    // (The child's write is rolled back WITH it only where a transaction exists — that half is certified on
    // the Pg adapter, packages/db/src/results/case-commit.test.ts. This single-process store has no rollback;
    // what survives here is the guarantee the case's outcome actually rests on, which is the receipt.)
    expect(await receipts.list(record.id)).toHaveLength(0);
  });
});
