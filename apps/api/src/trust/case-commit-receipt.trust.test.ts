import { InMemoryCaseReceiptStore, ScorecardService } from "@everdict/application-control";
import type { CaseJob, CaseResult } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
} from "@everdict/registry";
import { describe, expect, it } from "vitest";

// Trust suite (docs/trust-certification.md) — TRUST-166.
//
// AT MOST ONE CANONICAL OUTCOME PER CASE — decided by a constraint, not by a comparison made afterwards.
//
// Several PHYSICAL executions of one logical case are ordinary here: a runtime spillover, an OOM re-run at a
// higher ceiling, a speculative duplicate, a recovery re-drive. Each writes a child row and each row is real.
// Which one the parent counted was decided by `latestChildPerCase` — the largest `updatedAt` — which answers
// "which row was touched last", not "which attempt earned the right to commit". A late metadata write on a
// superseded attempt was therefore enough to change a settled batch's canonical result after the fact.
//
// The receipt is the commit point. What is asserted is the shape of the loss: the second attempt to arrive
// learns that the case is not its to publish, from the same mechanism that decides every other terminal
// write here — and the winner is the one that claimed it, whichever that was.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const result = (caseId: string): CaseResult => ({
  caseId,
  harness: "h@1.0.0",
  trace: [],
  scores: [{ metric: "pass", graderId: "g", value: 1 }],
  snapshot: { kind: "prompt", output: "" },
});

describeTrust("TRUST-166 — one case, one canonical commit", () => {
  it("a second attempt of the same case is refused the receipt, and the first one's stands", async () => {
    const receipts = new InMemoryCaseReceiptStore();
    const claim = (childRunId: string) =>
      receipts.commit({
        scorecardId: "sc-1",
        caseId: "c1",
        trial: 0,
        childRunId,
        executionId: "evd-sc-1-c1",
        generation: 1,
        resultDigest: `digest-of-${childRunId}`,
        committedAt: "2026-08-14T00:00:00.000Z",
      });

    const first = await claim("child-A");
    const second = await claim("child-B");
    expect(first.kind).toBe("committed");
    // Not an error and not a failure: another physical attempt got there first, and its evidence is the
    // case's. What the loser is told is WHOSE it is, so it never has to re-read (which would be racing again).
    expect(second.kind).toBe("already_committed");
    expect(second.receipt.childRunId).toBe("child-A");
    expect(await receipts.list("sc-1")).toHaveLength(1);
  });

  it("a trialled case commits once PER TRIAL — N trials are N cases, here as everywhere else", async () => {
    const receipts = new InMemoryCaseReceiptStore();
    const claim = (trial: number, childRunId: string) =>
      receipts.commit({
        scorecardId: "sc-1",
        caseId: "c1",
        trial,
        childRunId,
        resultDigest: "d",
        committedAt: "2026-08-14T00:00:00.000Z",
      });
    expect((await claim(0, "child-t0")).kind).toBe("committed");
    expect((await claim(1, "child-t1")).kind).toBe("committed");
    expect((await claim(1, "child-t1-dup")).kind).toBe("already_committed");
    expect(await receipts.list("sc-1")).toHaveLength(2);
  });

  it("a batch commits exactly one receipt per case through the real driver", async () => {
    // The seam as production runs it: submit → fan-out → per-case commit. The count is what matters — a
    // receipt per case, no more, written by the attempt that settled the child.
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", {
      id: "two",
      version: "1.0.0",
      tags: [],
      cases: ["c1", "c2"].map((id) => ({
        id,
        env: { kind: "prompt" as const },
        task: "t",
        graders: [],
        timeoutSec: 60,
        tags: [],
      })),
    });
    const receipts = new InMemoryCaseReceiptStore();
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(job: CaseJob) {
          return result(job.evalCase.id);
        },
      },
      store,
      runStore,
      datasets,
      caseReceipts: receipts,
      harnesses: new InMemoryHarnessInstanceRegistry(new InMemoryHarnessTemplateRegistry()),
    } as never);
    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "two", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      concurrency: 1,
    } as never);
    await new Promise((r) => setTimeout(r, 2000));

    const committed = await receipts.list(record.id);
    expect(committed.map((r) => r.caseId).sort()).toEqual(["c1", "c2"]);
    // Each receipt names the child row it made canonical, and the execution that produced it — which is the
    // question a replay reader has to answer and could not.
    const children = await runStore.list("acme", { scorecardId: record.id });
    for (const receipt of committed) {
      expect(children.some((child) => child.id === receipt.childRunId)).toBe(true);
      expect(receipt.executionId).toBe(`evd-${record.id}-${receipt.caseId}`);
    }
  }, 20_000);
});

// ── ONE FINALIZER, BOTH DRIVERS (review 39, Phase 2) ─────────────────────────────────────────────────
describeTrust("TRUST-167 — a case ends the same way whichever driver ended it", () => {
  // What is asserted is not that the two code paths look alike — it is that the ROW they leave is the same
  // one: judged with every selected judge accounted for, a receipt naming the attempt, and the evidence
  // assembled into the terminal write rather than after it. Both drivers reach it through the same call now,
  // so this is the regression that notices if one of them grows its own copy again.
  async function driveInProcess() {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", {
      id: "one",
      version: "1.0.0",
      tags: [],
      cases: [{ id: "c1", env: { kind: "prompt" as const }, task: "t", graders: [], timeoutSec: 60, tags: [] }],
    });
    const receipts = new InMemoryCaseReceiptStore();
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(job: CaseJob) {
          return result(job.evalCase.id);
        },
      },
      store,
      runStore,
      datasets,
      caseReceipts: receipts,
      harnesses: new InMemoryHarnessInstanceRegistry(new InMemoryHarnessTemplateRegistry()),
    } as never);
    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "one", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      concurrency: 1,
    } as never);
    await new Promise((r) => setTimeout(r, 1500));
    return { receipts, runStore, id: record.id };
  }

  it("the in-process driver leaves a receipt naming the child it committed", async () => {
    const { receipts, runStore, id } = await driveInProcess();
    const committed = await receipts.list(id);
    expect(committed).toHaveLength(1);
    const child = (await runStore.list("acme", { scorecardId: id }))[0];
    expect(committed[0]?.childRunId).toBe(child?.id);
    // The terminal row carries the case's result — assembled before the write, not amended after it.
    expect(child?.status).toBe("succeeded");
    expect(child?.result?.caseId).toBe("c1");
  }, 20_000);
});

// ── THE PARENT COUNTS WHAT THE LEDGER COMMITTED (review 39, Phase 3) ─────────────────────────────────
describeTrust("TRUST-168 — the summary is built from the committed children, not from memory", () => {
  it("counts the CHILD's result when the two differ — memory is not the record", async () => {
    // The driver holds the object the harness returned; the child row holds what was committed (judge
    // coverage may have added rows to it, and a re-drive may have committed another attempt's result
    // entirely). Summarizing from memory made the parent's answer depend on which of the two a reader asked.
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", {
      id: "one",
      version: "1.0.0",
      tags: [],
      cases: [{ id: "c1", env: { kind: "prompt" as const }, task: "t", graders: [], timeoutSec: 60, tags: [] }],
    });
    const receipts = new InMemoryCaseReceiptStore();
    const store = new InMemoryScorecardStore();
    const backing = new InMemoryRunStore();
    // The committed child carries a FAILING score; the in-memory result says pass. A summary built from
    // memory would report a passing batch over a ledger that says otherwise.
    const runStore = new Proxy(backing, {
      get(target, prop, receiver) {
        if (prop !== "update") return Reflect.get(target, prop, receiver);
        return async (id: string, patch: Record<string, unknown>, events: unknown, opts: unknown) => {
          const result = patch.result as CaseResult | undefined;
          const rewritten =
            result?.caseId === "c1"
              ? { ...patch, result: { ...result, scores: [{ metric: "pass", graderId: "g", value: 0, pass: false }] } }
              : patch;
          return backing.update(id, rewritten as never, events as never, opts as never);
        };
      },
    });
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(job: CaseJob) {
          return result(job.evalCase.id);
        },
      },
      store,
      runStore,
      datasets,
      caseReceipts: receipts,
      harnesses: new InMemoryHarnessInstanceRegistry(new InMemoryHarnessTemplateRegistry()),
    } as never);
    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "one", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      concurrency: 1,
    } as never);
    await new Promise((r) => setTimeout(r, 2000));

    // The SUMMARY is the assertion, because it is computed from the aggregate at settle time and frozen on
    // the record — a hydrated read would go to the child rows either way and could not tell the two apart.
    const settled = await store.get(record.id);
    const pass = settled?.summary?.find((m) => m.metric === "pass");
    expect(pass?.count).toBe(1);
    // What the ledger committed — not what the driver remembered: the committed child failed.
    expect(pass?.passRate).toBe(0);
    expect(pass?.mean).toBe(0);
  }, 20_000);
});
