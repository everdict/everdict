import {
  InMemoryCaseReceiptStore,
  InMemoryExecutionAttemptStore,
  ScorecardService,
} from "@everdict/application-control";
import { BadRequestError, type CaseJob, type CaseResult, UpstreamError } from "@everdict/contracts";
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

function serviceWith(dispatch: (job: CaseJob) => Promise<CaseResult>): {
  service: ScorecardService;
  attempts: InMemoryExecutionAttemptStore;
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
  const attempts = new InMemoryExecutionAttemptStore();
  const service = new ScorecardService({
    dispatcher: { dispatch },
    store,
    runStore: runs,
    datasets,
    caseReceipts: receipts,
    attempts,
    harnesses: new InMemoryHarnessInstanceRegistry(new InMemoryHarnessTemplateRegistry()),
  } as never);
  return { service, attempts, store, runs, datasets };
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
