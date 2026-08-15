import { InMemoryCaseReceiptStore, ScorecardService } from "@everdict/application-control";
import type { CaseCommitReceipt, CaseJob, CaseResult } from "@everdict/contracts";
import { BadRequestError, UpstreamError } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { Run, caseResultDigest } from "@everdict/domain";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
} from "@everdict/registry";
import { describe, expect, it } from "vitest";

// ── EVERY OUTCOME COMMITS THROUGH THE ONE ATOMIC POINT (arch-review 41 P0-lifecycle) ─────────────────
//
// Success already went receipt+terminal-write-in-one-transaction (review 40). Failures terminalized first
// and claimed a RAW receipt later; carried-over retry results existed only in process memory on the
// in-process driver. Both asymmetries are gone: the raw-commit refusal harness below is the proof — a store
// whose raw `commit` throws certifies that no live outcome path reaches for it.

class NoRawCommitReceiptStore extends InMemoryCaseReceiptStore {
  override commit(): Promise<never> {
    throw new Error("raw CaseReceiptStore.commit reached from a live lifecycle path");
  }
}

// A non-retryable dispatch failure — AppError so the failure exit records its own code, not INTERNAL.
class CaseBoom extends BadRequestError {
  constructor() {
    super("BAD_REQUEST", {}, "case exploded");
  }
}

function fixtures(): {
  service: ScorecardService;
  receipts: InMemoryCaseReceiptStore;
  runs: InMemoryRunStore;
  store: InMemoryScorecardStore;
} {
  const receipts = new NoRawCommitReceiptStore();
  const store = new InMemoryScorecardStore();
  store.attachReceipts((id) => receipts.countFor(id));
  const runs = new InMemoryRunStore();
  runs.attachScorecards(store);
  const datasets = new InMemoryDatasetRegistry();
  const service = new ScorecardService({
    dispatcher: {
      async dispatch(job: CaseJob): Promise<CaseResult> {
        if (job.evalCase.id === "c-fail") throw new CaseBoom();
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
  return { service, receipts, runs, store };
}

async function registerDataset(service: ScorecardService, ids: string[]): Promise<void> {
  // The service resolves the dataset through its own registry dep — reach it the same way submit does.
  const datasets = (service as unknown as { deps: { datasets: InMemoryDatasetRegistry } }).deps.datasets;
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

describe("failure outcomes commit atomically — receipt + fenced terminal fail-write, one transaction", () => {
  it("a failed case's receipt and terminal child land together, and no live path touches the raw commit", async () => {
    const { service, receipts, runs, store } = fixtures();
    await registerDataset(service, ["c-ok", "c-fail"]);
    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      retries: 0,
    } as never);
    await settled(store, record.id);

    // Both outcomes — the success AND the failure — are on the ledger…
    const committed = await receipts.list(record.id);
    expect(committed.map((r: CaseCommitReceipt) => r.caseId).sort()).toEqual(["c-fail", "c-ok"]);
    // …and each receipt's child is terminal, carrying the receipt's own bytes (the atomic point's contract).
    for (const r of committed) {
      const child = await runs.get(r.childRunId);
      expect(child && Run.from(child).isTerminal(), `${r.caseId}: receipt ⇒ terminal child`).toBe(true);
      expect(child?.result && caseResultDigest(child.result), `${r.caseId}: the child's own bytes`).toBe(
        r.resultDigest,
      );
    }
    // …each stamped with the outcome ledger's discriminant (arch-review 42): what KIND of outcome it is.
    expect(committed.find((r) => r.caseId === "c-ok")?.kind).toBe("executed");
    expect(committed.find((r) => r.caseId === "c-fail")?.kind).toBe("failed");
    const failChild = await runs.get((committed.find((r) => r.caseId === "c-fail") as CaseCommitReceipt).childRunId);
    expect(failChild?.status).toBe("failed");
    expect(failChild?.error?.code).toBe("BAD_REQUEST"); // the exit's own code, preserved through the atomic settle
  });

  it("a retryable throw abandons the superseded attempt's child at the re-dispatch — no open row survives", async () => {
    const receipts = new NoRawCommitReceiptStore();
    const store = new InMemoryScorecardStore();
    store.attachReceipts((id) => receipts.countFor(id));
    const runs = new InMemoryRunStore();
    runs.attachScorecards(store);
    const datasets = new InMemoryDatasetRegistry();
    let attempts = 0;
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(job: CaseJob): Promise<CaseResult> {
          attempts += 1;
          // First attempt: a retryable infra failure. Second: success.
          if (attempts === 1) throw new UpstreamError("UPSTREAM_ERROR", {}, "sandbox died");
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
    await datasets.register("acme", {
      id: "d",
      version: "1.0.0",
      tags: [],
      cases: [{ id: "c1", env: { kind: "prompt" as const }, task: "t", graders: [], timeoutSec: 60, tags: [] }],
    });
    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      retries: 1,
    } as never);
    expect(await settled(store, record.id)).toBe("succeeded");

    // The winner is receipted; the superseded first attempt's child is terminal (abandoned at the retry's
    // re-dispatch — where "not the answer" became a fact), and NO child is left open.
    const committed = await receipts.list(record.id);
    expect(committed).toHaveLength(1);
    const children = await runs.list("acme", { scorecardId: record.id });
    expect(children.length).toBeGreaterThanOrEqual(2);
    for (const c of children) expect(Run.from(c).isTerminal(), `${c.id} must not stay open`).toBe(true);
    const winner = children.find((c) => c.id === committed[0]?.childRunId);
    expect(winner?.status).toBe("succeeded");
    const abandoned = children.filter((c) => c.id !== committed[0]?.childRunId);
    for (const c of abandoned) expect(c.status).toBe("failed");
  });
});

describe("carried retry results are INHERITED outcomes — materialized as child + receipt on the in-process driver", () => {
  it("retry-failed commits the carried pass to the retry batch's own ledger (it used to live only in process memory)", async () => {
    const { service, receipts, runs, store } = fixtures();
    await registerDataset(service, ["c-ok", "c-fail"]);
    const source = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      retries: 0,
    } as never);
    await settled(store, source.id);

    const retry = await service.retryFailed({ tenant: "acme", id: source.id, submittedBy: "u" });
    await settled(store, retry.id);

    // The carried pass (c-ok) is on the RETRY batch's ledger: an inherited receipt naming a seeded child…
    const committed = await receipts.list(retry.id);
    expect(committed.map((r) => r.caseId).sort()).toEqual(["c-fail", "c-ok"]);
    const inherited = committed.find((r) => r.caseId === "c-ok") as CaseCommitReceipt;
    // The discriminant names it INHERITED and the lineage names the batch whose execution it actually is —
    // a reader no longer infers provenance from origin.retryOf plus absence-of-execution-id.
    expect(inherited.kind).toBe("inherited");
    expect(inherited.sourceScorecardId).toBe(source.id);
    expect(committed.find((r) => r.caseId === "c-fail")?.kind).toBe("failed");
    const seeded = await runs.get(inherited.childRunId);
    expect(seeded?.status).toBe("succeeded");
    expect(seeded?.parentScorecardId).toBe(retry.id);
    // …whose bytes are the receipt's (the atomic seed commit created both in one decision).
    expect(seeded?.result && caseResultDigest(seeded.result)).toBe(inherited.resultDigest);
  });
});
