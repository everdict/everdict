import {
  InMemoryCaseReceiptStore,
  InMemoryExecutionAttemptStore,
  type RecordingStore,
  ScorecardService,
} from "@everdict/application-control";
import { type AttemptRef, type CaseJob, type CaseResult, UpstreamError } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
} from "@everdict/registry";
import { describe, expect, it } from "vitest";

// ── AN ATTEMPT IS OPENED, CARRIED, AND ENDED — BY NAME (arch-review 51) ──────────────────────────────
//
// The ledger row's id used to be re-derived downstream as `attemptIdOf(executionId, generation)`, and the
// generation is the RECORDING fence: absent exactly when the recording claim was refused, while the row
// exists all the same. Two lifecycles fell through that gap, and both are certified here.
//
//   ① AN UNISOLATED ATTEMPT COULD NOT BE ADDRESSED. It opened, it ran, the case committed — and the row
//     stayed `created` for ever, because the only name the commit had was one the generation could not spell.
//   ② A RE-DISPATCH ABANDONED ITS PREDECESSOR SILENTLY. A spill (and an OOM boost, and a retry) opens a new
//     physical attempt because the previous one is DEAD; nothing ended the dead one, so the ledger reported
//     two live executions of a case that had one.
//
// The name now travels on the job (`CaseJob.attemptId`), which is also what lets a SELF-HOSTED park record
// which attempt it parked (runner_jobs.current_attempt_id) — the third test below is that carrier.

const passing = (job: CaseJob): CaseResult => ({
  caseId: job.evalCase.id,
  harness: "h@1.0.0",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: [{ metric: "pass", graderId: "g", value: 1, pass: true }],
});

function serviceWith(
  dispatch: (job: CaseJob, opts?: { onAttempt?: (attempt: AttemptRef) => void }) => Promise<CaseResult>,
  extra: Record<string, unknown> = {},
  // The ledger, when the test needs to hold it BEFORE the service exists — a dispatch that opens its own
  // attempt (the self-hosted re-lease's shape) writes into the same store the assertions read.
  ledger = new InMemoryExecutionAttemptStore(),
): {
  service: ScorecardService;
  attempts: InMemoryExecutionAttemptStore;
  store: InMemoryScorecardStore;
  datasets: InMemoryDatasetRegistry;
} {
  const receipts = new InMemoryCaseReceiptStore();
  const store = new InMemoryScorecardStore();
  store.attachReceipts((id) => receipts.countFor(id));
  const runs = new InMemoryRunStore();
  runs.attachScorecards(store);
  const datasets = new InMemoryDatasetRegistry();
  const attempts = ledger;
  const service = new ScorecardService({
    dispatcher: { dispatch },
    store,
    runStore: runs,
    datasets,
    caseReceipts: receipts,
    attempts,
    harnesses: new InMemoryHarnessInstanceRegistry(new InMemoryHarnessTemplateRegistry()),
    ...extra,
  } as never);
  return { service, attempts, store, datasets };
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

const submit = (service: ScorecardService, over: Record<string, unknown> = {}) =>
  service.submit({
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1.0.0" },
    createdBy: "u",
    retries: 0,
    ...over,
  } as never);

describe("the physical attempt travels by name, so every execution can be ended", () => {
  it("terminalizes an attempt whose recording claim was REFUSED — an unisolated execution still ends", async () => {
    // Given a recording store that refuses every claim: the attempt row is opened and marked unisolated, and
    // the generation is stripped from the job (the fail-closed live-only lane).
    const recordingStore = {
      async open() {
        throw new Error("recording buffer unavailable");
      },
      async append() {},
      async seal() {
        return undefined;
      },
      async get() {
        return undefined;
      },
      async peek() {
        return undefined;
      },
    } as unknown as RecordingStore;
    const { service, attempts, store, datasets } = serviceWith(async (job) => passing(job), { recordingStore });
    await registerDataset(datasets, ["c1"]);

    // When the batch runs to settlement
    const record = await submit(service);
    expect(await settled(store, record.id)).toBe("succeeded");

    // Then the attempt that ran is TERMINAL. It has no generation to be derived from — that is what
    // `unisolated` means — so before the name travelled, this row said `created` about a committed case.
    const rows = await attempts.listForScorecard(record.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unisolated).toBe(true);
    expect(rows[0]?.state).toBe("committed");
  });

  it("supersedes the attempt a runtime spillover abandoned, and commits the one that actually ran", async () => {
    // Given a sharded batch whose first runtime is dead (a retryable INFRA failure — what spillover is for)
    const seen: Array<string | undefined> = [];
    const { service, attempts, store, datasets } = serviceWith(async (job) => {
      const target = job.evalCase.placement?.target;
      seen.push(target);
      if (target === "rt-a") throw new UpstreamError("UPSTREAM_ERROR", {}, "runtime rt-a is gone");
      return passing(job);
    });
    await registerDataset(datasets, ["c1"]);

    // When the case spills onto the next runtime in the user's list
    const record = await submit(service, { runtime: "rt-a,rt-b" });
    expect(await settled(store, record.id)).toBe("succeeded");
    expect(seen).toEqual(["rt-a", "rt-b"]); // two PHYSICAL executions of one logical case

    // Then the ledger holds both, and the abandoned one is ENDED. The spill opens the successor precisely
    // because the predecessor is dead; nothing else ever learns that, so a supersede made anywhere later
    // could not exist — the row simply stood `executing` beside its successor's `committed`.
    const rows = await attempts.listForScorecard(record.id);
    expect(rows.map((r) => [r.generation, r.state])).toEqual([
      [1, "superseded"],
      [2, "committed"],
    ]);
    expect(rows[0]?.error?.code).toBe("ATTEMPT_SUPERSEDED");
    expect(rows[0]?.executionId).toBe(rows[1]?.executionId); // …two attempts of the SAME execution
  });

  it("hands the dispatched job the attempt it opened, and the re-dispatch's job its own", async () => {
    // Given the same spilling batch, watching what each dispatch is TOLD about its attempt
    const carried: Array<string | undefined> = [];
    const { service, attempts, store, datasets } = serviceWith(async (job) => {
      carried.push(job.attemptId);
      if (job.evalCase.placement?.target === "rt-a") throw new UpstreamError("UPSTREAM_ERROR", {}, "rt-a is gone");
      return passing(job);
    });
    await registerDataset(datasets, ["c1"]);

    const record = await submit(service, { runtime: "rt-a,rt-b" });
    expect(await settled(store, record.id)).toBe("succeeded");

    // Then each dispatch names its OWN row — which is what a self-hosted park writes into
    // `runner_jobs.current_attempt_id`, and what a later re-lease reads as the predecessor to supersede.
    // Carrying the first attempt's name onto the second would be worse than carrying none: the park would
    // record an attempt this execution never used.
    const rows = await attempts.listForScorecard(record.id);
    expect(carried).toEqual([rows[0]?.attemptId, rows[1]?.attemptId]);
    expect(carried[0]).not.toBe(carried[1]);
  });

  it("fails the attempt that DIED, not the one it replaced, when a spilled case runs out of runtimes", async () => {
    // Given a case that spills off a dead runtime and then hits a fatal failure on the next one
    const { service, attempts, store, datasets } = serviceWith(async (job) => {
      if (job.evalCase.placement?.target === "rt-a") throw new UpstreamError("UPSTREAM_ERROR", {}, "rt-a is gone");
      throw new UpstreamError("UPSTREAM_MISCONFIGURED", {}, "rt-b is misconfigured"); // fatal — nowhere left to go
    });
    await registerDataset(datasets, ["c1"]);

    const record = await submit(service, { runtime: "rt-a,rt-b" });
    expect(await settled(store, record.id)).toBe("succeeded"); // the BATCH completes; the case inside it failed

    // Then each physical execution ends as what it was: the first ABANDONED (its failure was not final — the
    // spill is the proof), the second FAILED. Naming the attempt by generation alone pointed the failure at
    // the first row, which the supersede had already closed, so the attempt that actually died stayed open.
    const rows = await attempts.listForScorecard(record.id);
    expect(rows.map((r) => [r.generation, r.state])).toEqual([
      [1, "superseded"],
      [2, "failed"],
    ]);
    expect(rows[1]?.error?.code).toBe("UPSTREAM_MISCONFIGURED");
  });

  it("commits the attempt a self-hosted RE-LEASE ran, not the one the dispatch parked", async () => {
    // Given a dispatch that reports back a DIFFERENT physical attempt — what a self-hosted requeue does: the
    // second runner's lease opens its own attempt and names it to the caller (DispatchOptions.onAttempt).
    const ledger = new InMemoryExecutionAttemptStore();
    const built = serviceWith(
      async (job, opts) => {
        const runId = job.runId;
        if (runId !== undefined) {
          const leased = await ledger.open({
            executionId: runId,
            tenant: "acme",
            ...(job.batchId !== undefined ? { scorecardId: job.batchId } : {}), // as the lease lane opens it
          });
          opts?.onAttempt?.({
            attemptId: leased.attemptId,
            executionId: runId,
            recording: { generation: leased.generation },
          });
        }
        return passing(job);
      },
      {},
      ledger,
    );
    await registerDataset(built.datasets, ["c1"]);

    const record = await submit(built.service);
    expect(await settled(built.store, record.id)).toBe("succeeded");

    // Then the COMMITTED row is the lease's. The job still carried the dispatch's attempt name, and a name
    // that outlives the generation it was minted with terminalizes the abandoned row while the execution that
    // produced the result is left open — the two halves are one coordinate, so they move together.
    const rows = await built.attempts.listForScorecard(record.id);
    expect(rows.map((r) => [r.generation, r.state])).toEqual([
      [1, "created"], // the dispatch's attempt — ended by the hub that replaced it, not by this commit
      [2, "committed"],
    ]);
  });

  it("stamps EXECUTING on the attempt that reached the machine — not the one a spill abandoned", async () => {
    // Given a ledger that records every transition (the executing stamp is transient — committed overwrites
    // it — so the final row cannot testify about who was stamped as having started)
    const ledger = new InMemoryExecutionAttemptStore();
    const transitions: Array<[string, string]> = [];
    const originalTransition = ledger.transition.bind(ledger);
    ledger.transition = async (...args: Parameters<typeof originalTransition>) => {
      transitions.push([args[0], args[1]]);
      return originalTransition(...args);
    };
    // …and a dispatcher that FIRES onStarted for every dispatch that begins compute (rt-a dies before
    // starting; rt-b starts and succeeds)
    const { service, store, datasets } = serviceWith(
      async (job, opts) => {
        const target = job.evalCase.placement?.target;
        if (target === "rt-a") throw new UpstreamError("UPSTREAM_ERROR", {}, "runtime rt-a is gone");
        (opts as { onStarted?: () => void } | undefined)?.onStarted?.();
        return passing(job);
      },
      {},
      ledger,
    );
    await registerDataset(datasets, ["c1"]);

    // When the case spills and the SECOND attempt is the one that actually starts
    const record = await submit(service, { runtime: "rt-a,rt-b" });
    expect(await settled(store, record.id)).toBe("succeeded");

    // Then the executing stamp names generation 2. The dispatch-time capture named generation 1 — already
    // superseded by the spill, so the stamp was silently refused and the attempt that reached the machine
    // went created → committed with no record of having started (arch-review 51 residue).
    const executing = transitions.filter(([, to]) => to === "executing").map(([id]) => id);
    expect(executing.some((id) => id.endsWith("#g2"))).toBe(true);
    expect(executing.some((id) => id.endsWith("#g1"))).toBe(false);
  });
});
