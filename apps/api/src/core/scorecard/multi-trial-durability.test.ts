import { InMemoryCaseReceiptStore, ScorecardService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { MANIFEST_IDENTITY_VERSION } from "@everdict/contracts";
import type { CaseJob, CaseResult, Dataset } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore, type ScorecardRecord } from "@everdict/db";
import { caseResultDigest, contentDigest } from "@everdict/domain";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";

// ── A TRIALLED BATCH IS DURABLE (arch-review 52, wave 1) ────────────────────────────────────────────
//
// `trials: k` is the statistical regression gate's own shape — one case, k physical executions, k receipts
// (the ledger's UNIQUE is `(scorecard, case, trial)`). Both durability paths reduced that to a case id and
// therefore refused the batch rather than mis-drive it:
//
//   · restart resume bailed on `isMultiTrial()` and tombstoned the batch INTERRUPTED, discarding every trial
//     that had already committed;
//   · submit routed every trialled batch away from the Temporal driver onto the in-process loop, so the runs
//     that cost k× the most were the ones with no durable owner at all.
//
// Both are keyed by (case, trial) now. These are the regressions for that.

const twoCases: Dataset = {
  id: "td",
  version: "1.0.0",
  cases: (["c1", "c2"] as const).map((id) => ({
    id,
    env: { kind: "prompt" as const },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
  })),
  tags: [],
};

const sealOf = (dataset: Dataset): ScorecardRecord["manifest"] => ({
  identityVersion: MANIFEST_IDENTITY_VERSION,
  dataset: { id: dataset.id, version: dataset.version, digest: contentDigest(dataset.cases) },
  cases: Object.fromEntries(dataset.cases.map((c) => [c.id, contentDigest({ ...c, graders: undefined })])),
  gradingCases: Object.fromEntries(dataset.cases.map((c) => [c.id, contentDigest(c.graders)])),
  harness: { id: "h", version: "1" },
});

const passResult = (caseId: string, trial?: number): CaseResult => ({
  caseId,
  ...(trial !== undefined ? { trial } : {}),
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: [{ graderId: "tests-pass", metric: "tests-pass", value: 1, pass: true }],
});

async function waitTerminal(store: InMemoryScorecardStore, id: string): Promise<ScorecardRecord> {
  for (let i = 0; i < 400; i++) {
    const rec = await store.get(id);
    if (rec && ["succeeded", "failed", "cancelled", "superseded"].includes(rec.status)) return rec;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("batch never settled");
}

describe("multi-trial durability — a resumed pass@k batch keeps the trials it committed", () => {
  it("resume re-dispatches only the (case, trial) pairs with no receipt, not the whole case", async () => {
    // Given a 2-case × 2-trial batch interrupted mid-flight: (c1,0) and (c1,1) both committed, (c2,0)
    // committed, (c2,1) never ran. On the case axis c1 is "done" and c2 is "not done" — which is exactly the
    // reduction that made this batch unresumable, because neither answer is true of (c2,0).
    const dispatched: Array<string> = [];
    const dispatcher: Dispatcher = {
      async dispatch(job: CaseJob) {
        dispatched.push(`${job.evalCase.id}#${job.trial ?? 0}`);
        return passResult(job.evalCase.id, job.trial);
      },
    };
    const store = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    const receipts = new InMemoryCaseReceiptStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", twoCases);
    let n = 0;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      runStore: runs,
      caseReceipts: receipts,
      newId: () => `id-${n++}`,
    } as never);

    await store.create({
      id: "sc-mt",
      tenant: "acme",
      dataset: { id: "td", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      manifest: sealOf(twoCases),
      status: "running",
      // The batch's own ask — cases × trials. Without it the resume re-drove the remainder single-trial,
      // which is a different experiment from the one the submitter asked for.
      orchestration: { judges: [], concurrency: 2, retries: 0, trials: 2 },
      requested: 4,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const committed: Array<{ caseId: string; trial: number }> = [
      { caseId: "c1", trial: 0 },
      { caseId: "c1", trial: 1 },
      { caseId: "c2", trial: 0 },
    ];
    for (const { caseId, trial } of committed) {
      const childId = `child-${caseId}-t${trial}`;
      const result = passResult(caseId, trial);
      await runs.create({
        id: childId,
        tenant: "acme",
        harness: { id: "h", version: "1" },
        caseId,
        status: "succeeded",
        result,
        parentScorecardId: "sc-mt",
        createdAt: "2026-08-01T00:00:01.000Z",
        updatedAt: "2026-08-01T00:00:02.000Z",
      });
      await receipts.commit({
        scorecardId: "sc-mt",
        caseId,
        trial,
        childRunId: childId,
        resultDigest: caseResultDigest(result),
        committedAt: "2026-08-01T00:00:02.000Z",
      });
    }

    // When the control plane comes back and resumes it
    expect(await service.resume("sc-mt")).toEqual({ kind: "resumed" });
    const rec = await waitTerminal(store, "sc-mt");

    // Then exactly the ONE unfinished execution was re-dispatched — not c2's committed trial beside it, and
    // not c1 at all.
    expect(dispatched).toEqual(["c2#1"]);
    expect(rec.status).toBe("succeeded");
    // …and the settled batch carries all four executions, one per (case, trial).
    const hydrated = await service.get("sc-mt");
    const keys = (hydrated?.scorecard?.results ?? []).map((r) => `${r.caseId}#${r.trial ?? 0}`).sort();
    expect(keys).toEqual(["c1#0", "c1#1", "c2#0", "c2#1"]);
  });
});

describe("multi-trial durability — a trialled batch takes the durable driver", () => {
  it("submit starts the Temporal workflow for trials > 1, and the plan carries one item per (case, trial)", async () => {
    const started: string[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job: CaseJob) {
        return passResult(job.evalCase.id, job.trial);
      },
    };
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", twoCases);
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      runStore: new InMemoryRunStore(),
      caseReceipts: new InMemoryCaseReceiptStore(),
      newId: () => "sc-wf-mt",
      temporalBatches: {
        workflowIdFor: (id: string) => `everdict-batch-${id}`,
        start: async (id: string) => {
          started.push(id);
        },
      },
    } as never);

    // When a pass@k batch is submitted with the durable driver configured
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "td", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      trials: 2,
    });

    // Then the workflow owns it — it used to be silently demoted to the in-process loop, which is the loop
    // that dies with the process.
    expect(started).toEqual(["sc-wf-mt"]);
    expect(rec.orchestration?.workflowId).toBe("everdict-batch-sc-wf-mt");
    expect(rec.orchestration?.trials).toBe(2);

    // …and the plan the workflow drives is stated in (case, trial): four executions, not two cases.
    const plan = await service.planBatch("sc-wf-mt");
    expect(plan.items).toEqual([
      { caseId: "c1", trial: 0 },
      { caseId: "c1", trial: 1 },
      { caseId: "c2", trial: 0 },
      { caseId: "c2", trial: 1 },
    ]);
  });

  it("a single-trial plan still answers with the trial-less shape an older workflow drives from", async () => {
    // Wire compatibility, stated: `caseIds` is unchanged and `items` carries no trial axis, so a workflow
    // execution started before this shipped keeps driving its recorded plan verbatim.
    const dispatcher: Dispatcher = {
      async dispatch(job: CaseJob) {
        return passResult(job.evalCase.id);
      },
    };
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", twoCases);
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      runStore: new InMemoryRunStore(),
      caseReceipts: new InMemoryCaseReceiptStore(),
      newId: () => "sc-wf-st",
      temporalBatches: { workflowIdFor: (id: string) => `wf-${id}`, start: async () => {} },
    } as never);
    await service.submit({
      tenant: "acme",
      dataset: { id: "td", version: "1.0.0" },
      harness: { id: "h", version: "1" },
    });

    const plan = await service.planBatch("sc-wf-st");
    expect(plan.caseIds).toEqual(["c1", "c2"]);
    expect(plan.items).toEqual([{ caseId: "c1" }, { caseId: "c2" }]);
  });
});
