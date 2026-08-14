import { InMemoryCaseReceiptStore, ScorecardService } from "@everdict/application-control";
import type { CaseJob, CaseResult } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
} from "@everdict/registry";
import { describe, expect, it } from "vitest";

// Trust suite (docs/trust-certification.md) — TRUST-146.
//
// PRIMITIVE CERTIFIED IS NOT SEAM CERTIFIED — the same lesson Temporal taught, applied to the fence.
//
// TRUST-142 certifies that a guarded touch under a stale epoch is REFUSED. That is a fact about the store,
// and the store was never the thing in doubt: the production question is whether the batch loop consults
// that answer before it spends compute. A scenario that builds the proof inside itself answers "the CAS
// works" while the defect it is named after — "a fenced driver keeps dispatching" — lives entirely in the
// caller. The two look identical on a certification page and only one of them is about production.
//
// So this drives the REAL `ScorecardService` → `ScorecardBatchService.track()` fan-out against a real
// dispatcher, and stages the takeover where it actually happens: while a case is in flight. What is asserted
// is not a return value but an ABSENCE — no case is dispatched after the epoch moved. A batch of five cases
// that dispatches one is a driver that noticed; one that dispatches five is the defect, on a row that stayed
// perfectly honest the whole time.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const CASES = ["c1", "c2", "c3", "c4", "c5"];

async function buildService(dispatch: (job: CaseJob) => Promise<CaseResult>) {
  const datasets = new InMemoryDatasetRegistry();
  await datasets.register("acme", {
    id: "five",
    version: "1.0.0",
    tags: [],
    cases: CASES.map((id) => ({
      id,
      env: { kind: "prompt" as const },
      task: "t",
      graders: [],
      timeoutSec: 60,
      tags: [],
    })),
  });
  const templates = new InMemoryHarnessTemplateRegistry();
  const harnesses = new InMemoryHarnessInstanceRegistry(templates);
  const store = new InMemoryScorecardStore();
  const runStore = new InMemoryRunStore();
  const service = new ScorecardService({
    dispatcher: { dispatch },
    store,
    runStore,
    caseReceipts: new InMemoryCaseReceiptStore(),
    datasets,
    harnesses,
  });
  return { service, store, runStore };
}

const result = (caseId: string): CaseResult => ({
  caseId,
  harness: "h@1.0.0",
  trace: [],
  scores: [{ metric: "pass", graderId: "g", value: 1 }],
  snapshot: { kind: "prompt", output: "" },
});

describeTrust("TRUST-146 — a fenced driver stops DISPATCHING, at the real batch seam", () => {
  it("a takeover mid-batch stops the displaced loop before it spends compute on the next case", async () => {
    const dispatched: string[] = [];
    let takeover: (() => Promise<void>) | undefined;

    const { service, store } = await buildService(async (job) => {
      dispatched.push(job.evalCase.id);
      // The takeover lands while the FIRST case is in flight — the shape a paused-then-declared-dead replica
      // actually meets, rather than a tidy boundary between cases.
      if (takeover) {
        const claim = takeover;
        takeover = undefined;
        await claim();
      }
      return result(job.evalCase.id);
    });

    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "five", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      concurrency: 1, // one at a time, so "did it stop" is a question with an answer
    } as never);

    takeover = async () => {
      // Another replica declares this one dead and claims the batch: identity transfers and the fencing
      // token rises in the same statement. Nothing tells the running loop — that is the entire point.
      const claimed = await store.update(record.id, { ownerReplica: "cp-b" }, undefined, {
        expectNonTerminal: true,
        claimOwnership: true,
      });
      expect(claimed?.ownerEpoch).toBeGreaterThan(0);
    };

    await new Promise((r) => setTimeout(r, 2000));

    // ONE case ran. The displaced driver proved its authority before the second and was refused — so the
    // work stopped where the ownership did, instead of running the remaining four on compute it no longer
    // owned and settling a batch that now belongs to somebody else.
    expect(dispatched.length).toBe(1);
    expect(dispatched).toEqual(["c1"]);
  }, 20_000);

  it("…and an untouched batch runs every case — the fence stops usurped drivers, not ordinary ones", async () => {
    const dispatched: string[] = [];
    const { service, store } = await buildService(async (job) => {
      dispatched.push(job.evalCase.id);
      return result(job.evalCase.id);
    });
    const { id } = await service.submit({
      tenant: "acme",
      dataset: { id: "five", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      concurrency: 1,
    } as never);
    await new Promise((r) => setTimeout(r, 2000));
    expect(dispatched).toEqual(CASES);
    expect((await store.get(id))?.status).toBe("succeeded");
  }, 20_000);
});
