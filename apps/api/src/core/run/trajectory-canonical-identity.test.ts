import { InMemoryCaseReceiptStore, RunService } from "@everdict/application-control";
import type { CaseCommitReceipt, RunRecord } from "@everdict/contracts";
import { InMemoryRunStore } from "@everdict/db";
import { describe, expect, it } from "vitest";

// ── THE RECEIPT SAYS WHICH EVIDENCE IS CANONICAL (arch-review 52, Wave 7) ────────────────────────────
//
// The trajectory store is append-oriented: on the ClickHouse rung two replicas can both seal a plane for
// one run, and the tiebreak is the WRITER'S clock — so an attempt that finished late with a backdated
// stamp can out-rank the attempt that actually answered the case. Wave 7 gave the store an exact-identity
// read; this is the caller that supplies the identity. The receipt ledger already knows which attempt
// committed, so the run's trajectory read asks for THAT one instead of accepting the clock's answer.
//
// Without this the exact read would be surface with no caller — a capability the store advertises and
// nothing uses, which is the shape the api-layer rule refuses.

const childRun = (over: Partial<RunRecord> = {}): RunRecord =>
  ({
    id: "child-1",
    tenant: "acme",
    harness: { id: "h", version: "1" },
    caseId: "c1",
    status: "succeeded",
    parentScorecardId: "sc-1",
    trigger: "scorecard",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:01.000Z",
    ...over,
  }) as RunRecord;

const receipt = (over: Partial<CaseCommitReceipt> = {}): CaseCommitReceipt =>
  ({
    scorecardId: "sc-1",
    caseId: "c1",
    trial: 0,
    childRunId: "child-1",
    attemptId: "evd-sc-1-c1#g2",
    committedAt: "2026-08-16T00:00:01.000Z",
    ...over,
  }) as CaseCommitReceipt;

function world(receipts: CaseCommitReceipt[], record: RunRecord = childRun()) {
  const runs = new InMemoryRunStore();
  const store = new InMemoryCaseReceiptStore();
  const asked: Array<string | undefined> = [];
  const trajectories = {
    async get(_tenant: string, runId: string, opts?: { attemptId: string }) {
      asked.push(opts?.attemptId);
      const events = [{ t: 0, kind: "message", role: "assistant", text: "done" }];
      return {
        meta: { runId, tenant: "acme", source: "run", eventCount: 1, sealedAt: "2026-08-16T00:00:02.000Z" },
        events,
        executionEmitter: "run",
        segments: [
          {
            emitter: "run",
            source: "run",
            eventCount: 1,
            sealedAt: "2026-08-16T00:00:02.000Z",
            format: "everdict",
            events,
          },
        ],
      };
    },
  };
  const service = new RunService({
    dispatcher: {
      async dispatch() {
        throw new Error("not under test");
      },
    },
    store: runs,
    trajectories,
    caseReceipts: receipts.length > 0 ? store : undefined,
  } as never);
  return { runs, store, service, asked, record };
}

describe("RunService.trajectory — the canonical attempt comes from the receipt, not the store's clock", () => {
  it("asks the trajectory store for the attempt the receipt vouches for", async () => {
    const receipts = [receipt()];
    const { runs, store, service, asked, record } = world(receipts);
    await runs.create(record);
    for (const r of receipts) await store.commit(r);

    const trajectory = await service.trajectory("acme", "child-1", "u");

    expect(trajectory).toBeDefined();
    expect(asked).toEqual(["evd-sc-1-c1#g2"]); // the committed attempt, not "whatever sealed first"
  });

  it("a run with no receipt — standalone, legacy, or never committed — reads exactly as before", async () => {
    const { runs, service, asked } = world([], childRun({ parentScorecardId: undefined, id: "solo-1" }));
    await runs.create(childRun({ parentScorecardId: undefined, id: "solo-1" }));

    await service.trajectory("acme", "solo-1", "u");

    expect(asked).toEqual([undefined]); // no identity to ask with: the clock read, unchanged
  });

  it("another child's receipt is not this run's — the identity is matched by child run id", async () => {
    const receipts = [receipt({ caseId: "c9", childRunId: "child-9", attemptId: "evd-sc-1-c9#g1" })];
    const { runs, store, service, asked, record } = world(receipts);
    await runs.create(record);
    for (const r of receipts) await store.commit(r);

    await service.trajectory("acme", "child-1", "u");

    expect(asked).toEqual([undefined]); // no receipt for THIS child — never another case's attempt
  });
});
