import { InMemoryCaseReceiptStore, ScorecardService } from "@everdict/application-control";
import type { CaseJob, CaseResult } from "@everdict/contracts";
import { InMemoryPlatformEventStore, InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { caseResultDigest, contentDigest } from "@everdict/domain";
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
//
// The accounting is the same on every settle path — a counted outcome traces to a receipt on the (case,
// trial) axis and the child row's bytes are the receipt's — and what differs is the verdict on a case the
// ledger cannot vouch for. This scenario pins the SUCCESS gate: it REFUSES. The failure/supersede settles
// count the vouched results only and DROP the rest onto the batch's timeline instead of refusing (a batch
// already ending badly has nowhere better to be left); that half is pinned in
// apps/api/src/core/scorecard/outcome-commit-atomicity.test.ts. Neither path ever counts an unvouched case.
describeTrust("TRUST-168 — the summary is built from the committed children, not from memory", () => {
  it("REFUSES the batch when the child row's bytes are not its receipt's — neither memory nor the row is silently counted", async () => {
    // The driver holds the object the harness returned; the child row holds what the store persisted. When
    // the two disagree, the receipt is the arbiter — its digest names the committed bytes. A row that
    // diverges from its own receipt is a permanent split a reader will hydrate a year from now, so the
    // parent must not summarize over it: not from the row (the ledger does not vouch for it) and not from
    // memory (that is the pre-receipt defect wearing a new coat). The batch fails into a recoverable state.
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

    const settled = await store.get(record.id);
    // The batch REFUSED to settle succeeded — the failure names the receipt gate, and the state is
    // recoverable (a re-drive re-commits the case and the second pass finalizes). The partial summary a
    // FAILED batch freezes for visibility is diagnostic, not a verdict: nothing downstream (baseline,
    // leaderboard, release gates) reads a failed batch as an answer.
    expect(settled?.status).toBe("failed");
    expect(settled?.error?.message).toContain("cannot be traced to a committed receipt");
  }, 20_000);
});

// ── EVERY COUNTED OUTCOME HAS A RECEIPT — THE FAILURE EXIT INCLUDED (review 40 P0) ───────────────────
describeTrust("TRUST-171 — a failure is committed, not merely recorded", () => {
  const dataset = {
    id: "mixed",
    version: "1.0.0",
    tags: [],
    cases: ["c-ok", "c-boom"].map((id) => ({
      id,
      env: { kind: "prompt" as const },
      task: "t",
      graders: [],
      timeoutSec: 60,
      tags: [],
    })),
  };

  it("a case that dies at dispatch leaves a receipt whose digest names the failed child's own bytes", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", dataset);
    const receipts = new InMemoryCaseReceiptStore();
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(job: CaseJob) {
          if (job.evalCase.id === "c-boom") throw new Error("sandbox evaporated");
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
      dataset: { id: "mixed", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      concurrency: 1,
    } as never);
    await new Promise((r) => setTimeout(r, 2000));

    // The batch settled (a failed case is a measured part of the batch's story, not a batch failure)…
    expect((await store.get(record.id))?.status).toBe("succeeded");
    // …and BOTH outcomes are on the receipt ledger — a parent that counts an outcome the ledger never
    // committed is the exact fail-open the failure exit used to be.
    const committed = await receipts.list(record.id);
    expect(committed.map((r) => r.caseId).sort()).toEqual(["c-boom", "c-ok"]);
    // The failure receipt names the failed child, and its digest is the digest of the bytes that child
    // carries — the synthesized failure result settles WITH the child now, so a reader can rebuild the
    // counted failure from the row.
    const boom = committed.find((r) => r.caseId === "c-boom");
    const failedChild = (await runStore.list("acme", { scorecardId: record.id })).find(
      (c) => c.id === boom?.childRunId,
    );
    expect(failedChild?.status).toBe("failed");
    expect(failedChild?.result?.failure?.class).toBe("infra");
    expect(failedChild?.result && caseResultDigest(failedChild.result)).toBe(boom?.resultDigest);
  }, 20_000);

  it("a RETRY reopens the case — the receipt names the attempt that answered, not the one that died first", async () => {
    // The regression this pins (review 40): the failure exit marked the (case, trial) finalized; a retryable
    // throw was then re-dispatched by runSuite, and the judged exit read "already ended" about the retried
    // SUCCESS — its child stayed running forever under a batch that reported the case done.
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", { ...dataset, id: "retry", cases: dataset.cases.slice(1, 2) }); // c-boom only
    const receipts = new InMemoryCaseReceiptStore();
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    let attempts = 0;
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(job: CaseJob) {
          attempts += 1;
          if (attempts === 1) throw new Error("transient placement blip"); // unknown throw → retryable infra
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
      dataset: { id: "retry", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      concurrency: 1,
      retries: 1,
    } as never);
    await new Promise((r) => setTimeout(r, 2000));

    expect(attempts).toBe(2);
    const settled = await store.get(record.id);
    expect(settled?.status).toBe("succeeded");
    expect(settled?.summary?.find((m) => m.metric === "pass")?.mean).toBe(1); // the retried SUCCESS counted
    // Exactly one receipt for the case, and it names the SECOND child (the attempt that answered); the first
    // attempt's child is a terminal failed row with no claim on the case.
    const committed = await receipts.list(record.id);
    expect(committed).toHaveLength(1);
    const children = await runStore.list("acme", { scorecardId: record.id });
    const canonical = children.find((c) => c.id === committed[0]?.childRunId);
    expect(canonical?.status).toBe("succeeded");
    const loser = children.find((c) => c.id !== committed[0]?.childRunId);
    expect(loser?.status).toBe("failed"); // the died-first attempt is terminal, not a zombie
  }, 20_000);

  it("a failure whose fenced settle was REFUSED claims no receipt — this driver publishes nothing and the batch stays OPEN for its successor", async () => {
    // The displaced-driver shape: the fail-settle bounces off the fence inside the atomic commit, so the
    // claim rolled back with it — no receipt, no terminal child, the poison pill structurally impossible.
    // Since failures commit through the SAME protocol as successes (arch-review 41), a refused fence reads
    // the same way on both: the case belongs to whoever holds the authority now, this driver stops
    // publishing (AuthorityLostError), and the batch is left OPEN — recovery re-drives it and the second
    // pass commits. The old asymmetric reading (fail the batch loudly) pre-dated the unified commit.
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", { ...dataset, id: "fenced" });
    const receipts = new InMemoryCaseReceiptStore();
    const store = new InMemoryScorecardStore();
    const backing = new InMemoryRunStore();
    // Refuse exactly the FAIL-settle (the displaced driver's write); everything else lands normally.
    const runStore = new Proxy(backing, {
      get(target, prop, receiver) {
        if (prop !== "update") return Reflect.get(target, prop, receiver);
        return async (id: string, patch: Record<string, unknown>, events: unknown, opts: unknown) => {
          if (patch.status === "failed") return undefined; // the fence said no
          return backing.update(id, patch as never, events as never, opts as never);
        };
      },
    });
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(job: CaseJob) {
          if (job.evalCase.id === "c-boom") throw new Error("sandbox evaporated");
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
      dataset: { id: "fenced", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      concurrency: 1,
    } as never);
    await new Promise((r) => setTimeout(r, 2000));

    const settled = await store.get(record.id);
    // The displaced driver published NOTHING: no success, no failure record — the batch is the successor's,
    // including its ending, and it is left open in exactly the state recovery re-drives.
    expect(settled?.status).toBe("running");
    // No receipt was claimed for the refused case — the successor can still commit it.
    const committed = await receipts.list(record.id);
    expect(committed.some((r) => r.caseId === "c-boom")).toBe(false);
  }, 20_000);
});

// ── THE COMPLETION FACT RIDES THE COMMIT (review 40 follow-up, E0) ───────────────────────────────────
describeTrust("TRUST-171 — the case-completed fact is persisted with the child's commit", () => {
  it("a committed case leaves its scorecard.case.completed on the SAME store write the ledger saw", async () => {
    // The fact used to be a fire-and-forget emit after the commit — a crash between the two left a committed
    // case nobody was told about, and a loser that emitted anyway told the workspace about a case the ledger
    // never counted. Riding the child's terminal write (settleRun's outbox arm, one transaction with the
    // receipt on Pg) makes both impossible by construction.
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", {
      id: "one-fact",
      version: "1.0.0",
      tags: [],
      cases: [{ id: "c1", env: { kind: "prompt" as const }, task: "t", graders: [], timeoutSec: 60, tags: [] }],
    });
    const receipts = new InMemoryCaseReceiptStore();
    const store = new InMemoryScorecardStore();
    const facts = new InMemoryPlatformEventStore();
    const runStore = new InMemoryRunStore(facts); // the E0 pair: events append with the write
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
      dataset: { id: "one-fact", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      concurrency: 1,
    } as never);
    await new Promise((r) => setTimeout(r, 2000));

    expect((await store.get(record.id))?.status).toBe("succeeded");
    const completed = (await facts.list("acme")).filter((e) => e.kind === "scorecard.case.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.subject).toEqual({ type: "scorecard", id: record.id });
    expect(completed[0]?.payload).toMatchObject({ caseId: "c1" });
  }, 20_000);
});

// ── WHAT THE PARENT READ IS WHAT THE PARENT COMMITTED ON (review 40, the Release pattern) ────────────
describeTrust("TRUST-175 — the settle freezes its read-set and conditions on it", () => {
  it("a settled batch records the exact receipts it counted, and the digest vector matches the ledger", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", {
      id: "two-dc",
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
    store.attachReceipts((id) => receipts.countFor(id)); // the composition's pairing — the CAS is live here
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
      dataset: { id: "two-dc", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      concurrency: 2,
    } as never);
    await new Promise((r) => setTimeout(r, 2000));

    const settled = await store.get(record.id);
    expect(settled?.status).toBe("succeeded");
    const decision = settled?.decision;
    if (!decision) throw new Error("expected the settle to freeze its decision context");
    const committed = await receipts.list(record.id);
    // The read-set is EXACTLY the ledger: same count (what the terminal write conditioned on), same rows.
    expect(decision.receiptCount).toBe(committed.length);
    const byKey = new Map(committed.map((r) => [`${r.caseId}#${r.trial}`, r] as const));
    for (const c of decision.cases) {
      const receipt = byKey.get(`${c.caseId}#${c.trial}`);
      expect(receipt?.childRunId).toBe(c.childRunId);
      expect(receipt?.resultDigest).toBe(c.resultDigest);
    }
    expect(decision.receiptSetDigest).toBe(contentDigest(decision.cases));
  }, 20_000);
});

// ── THE LEDGER KEEPS THE TRIAL AXIS (review 40 P0) ───────────────────────────────────────────────────
describeTrust("TRUST-172 — a trialled batch is summarized from the ledger, per (case, trial)", () => {
  it("N trials leave N receipts per case and the parent aggregates them — no memory fallback", async () => {
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
          return { ...result(job.evalCase.id), ...(job.trial !== undefined ? { trial: job.trial } : {}) };
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
      concurrency: 2,
      trials: 2,
    } as never);
    await new Promise((r) => setTimeout(r, 2000));

    const settled = await store.get(record.id);
    // Before the trial axis reached the aggregation, a trialled batch abandoned the ledger entirely (the
    // rebuild collapsed N trials into one slot) — the receipt gate would now REFUSE such a batch, so a
    // succeeded trialled batch is itself the certification that the ledger accounted for every trial.
    expect(settled?.status).toBe("succeeded");
    const committed = await receipts.list(record.id);
    expect(committed.map((r) => `${r.caseId}#${r.trial}`).sort()).toEqual(["c1#0", "c1#1"]);
    // Each trial's receipt names its own child, and both children are terminal with their own bytes.
    const children = await runStore.list("acme", { scorecardId: record.id });
    for (const r of committed) {
      const trialChild = children.find((c) => c.id === r.childRunId);
      expect(trialChild?.status).toBe("succeeded");
      expect(trialChild?.result && caseResultDigest(trialChild.result)).toBe(r.resultDigest);
    }
  }, 20_000);
});
