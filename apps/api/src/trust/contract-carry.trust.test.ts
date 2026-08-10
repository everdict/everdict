import { ScorecardService, type SeriesContractDeps, resolveSeriesContract } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/application-control";
import { ConflictError, type Dataset, type HarnessSpec, type ProductSeries } from "@everdict/contracts";
import { InMemoryScorecardStore } from "@everdict/db";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
} from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { TRUST_SUITE_ENABLED } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-67.
//
// USING THE SAME RESOLVER TWICE IS NOT CARRYING ONE RESOLUTION.
//
// The last wave removed IMPLEMENTATION drift between the product's evaluation contract and the scorecard's
// manifest: both now seal through the same functions. That leaves TEMPORAL drift, which no amount of shared
// code can close — the product resolves a series' floating `model: {ref}` to `M@3` and stamps that digest on
// the batch's origin; `latest` moves; submit re-resolves to `M@4` and seals it into the manifest. Nothing
// errors, and the record then states, in its own two fields, that it answered a question it did not answer.
//
// So submit is HELD to the resolution it was asked for, and refuses before it creates or dispatches anything.
// A mismatch costs the caller a retry; the alternative costs a piece of evidence that misstates itself, which
// is the more expensive of the two by a wide margin.
const describeTrust = TRUST_SUITE_ENABLED ? describe : describe.skip;

const dataset = (): Dataset => ({
  id: "d",
  version: "1.0.0",
  cases: [
    {
      id: "c1",
      env: { kind: "repo", source: { files: { "a.txt": "x" } } },
      task: "do",
      graders: [],
      timeoutSec: 60,
      tags: [],
    },
  ],
  tags: [],
});

const commandSpec = (): HarnessSpec =>
  ({
    kind: "command",
    id: "cli",
    version: "1.0.0",
    command: "run {{task}}",
    model: { ref: "agent-model" }, // FLOATING — this is the reference that moves
    trace: { kind: "none" },
    setup: [],
    params: {},
  }) as unknown as HarnessSpec;

class StubHarnessRegistry extends InMemoryHarnessInstanceRegistry {
  constructor() {
    super(new InMemoryHarnessTemplateRegistry());
  }
  override get(): Promise<HarnessSpec> {
    return Promise.resolve(commandSpec());
  }
  override versions(): Promise<string[]> {
    return Promise.resolve(["1.0.0"]);
  }
}

const series: ProductSeries = {
  key: "quality",
  dataset: { id: "d" },
  harness: { id: "cli" },
  judges: [],
} as unknown as ProductSeries;

const neverDispatches: Dispatcher = {
  async dispatch() {
    throw new Error("dispatch must not be reached — the contract check runs before anything is created");
  },
};

describeTrust("TRUST-67 — a resolution that moved before submit is refused, never silently re-sealed", () => {
  async function world(modelVersion: string) {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", dataset());
    const harnesses = new StubHarnessRegistry();
    const resolveModelBinding = async (_t: string, b: { ref: string }) => `${b.ref}@${modelVersion}`;
    const deps = { datasets, harnesses, judges: undefined, resolveModelBinding } as unknown as SeriesContractDeps;
    return { datasets, harnesses, resolveModelBinding, deps };
  }

  it("refuses when the harness's floating model moved between the product's resolve and submit's seal", async () => {
    // T1 — the product resolves the series. `agent-model` latest is at 3.
    const at3 = await world("3.0.0");
    const resolution = await resolveSeriesContract(at3.deps, "acme", series);
    if (resolution.status !== "resolved") throw new Error(resolution.status);
    expect(resolution.contract.harnessModel).toBe("agent-model@3.0.0");

    // T2 — someone registers agent-model 4, so `latest` now means something else.
    const at4 = await world("4.0.0");

    // T3 — submit, presenting what T1 resolved. Submit seals `agent-model@4.0.0` and must NOT proceed.
    const service = new ScorecardService({
      dispatcher: neverDispatches,
      store: new InMemoryScorecardStore(),
      datasets: at4.datasets,
      harnesses: at4.harnesses,
      resolveModelBinding: at4.resolveModelBinding,
      newId: () => "sc-drift",
    });
    await expect(
      service.submit({
        tenant: "acme",
        dataset: { id: "d", version: "1.0.0" },
        harness: { id: "cli", version: "1.0.0" },
        expectedContractDigest: resolution.digest,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("TRUST-90 — a refused submit spends no autonomy budget: the right survives the rejection", async () => {
    // `capRuns` is a durable, conserved right — an agent's delegation. It used to be claimed BEFORE the batch
    // was known to be runnable, so a submission refused for a moved evaluation contract had already consumed
    // a delegation the caller got no execution for. An autonomy budget should be claimed by requests that can
    // actually run; every refusal above the admission line is one the caller must fix and retry.
    const at3 = await world("3.0.0");
    const resolution = await resolveSeriesContract(at3.deps, "acme", series);
    if (resolution.status !== "resolved") throw new Error(resolution.status);
    const at4 = await world("4.0.0");
    let admitted = 0;
    const service = new ScorecardService({
      dispatcher: neverDispatches,
      store: new InMemoryScorecardStore(),
      datasets: at4.datasets,
      harnesses: at4.harnesses,
      resolveModelBinding: at4.resolveModelBinding,
      // Any read of the causer's envelope means the admission ran; the contract refusal must precede it.
      runStore: {
        async get() {
          admitted += 1;
          return undefined;
        },
      } as never,
      newId: () => "sc-budget",
    });
    await expect(
      service.submit({
        tenant: "acme",
        dataset: { id: "d", version: "1.0.0" },
        harness: { id: "cli", version: "1.0.0" },
        origin: { source: "agent", causedByRunId: "run-parent" } as never,
        expectedContractDigest: resolution.digest,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(admitted).toBe(0);
  });

  it("TRUST-91 — a right claimed for work that never existed is given back", async () => {
    // `capRuns` is a conserved right. The admission is durable and the create that follows it can still fail
    // — a database error in between left the counter incremented with no scorecard, no execution, and a
    // delegation the caller could never use. Fail-closed rather than an overspend, and still a defect: the
    // retry mints a NEW batch id, so the same logical submission is charged twice.
    const at3 = await world("3.0.0");
    let released: string | undefined;
    const service = new ScorecardService({
      dispatcher: neverDispatches,
      store: {
        async create() {
          throw new Error("the database was unavailable");
        },
        async update() {
          return undefined;
        },
        async get() {
          return undefined;
        },
        async list() {
          return [];
        },
        async delete() {
          return false;
        },
      } as never,
      datasets: at3.datasets,
      harnesses: at3.harnesses,
      resolveModelBinding: at3.resolveModelBinding,
      runStore: {
        async get() {
          return {
            id: "run-parent",
            tenant: "acme",
            envelope: { id: "env-1", capRuns: 1 },
            createdAt: "2026-01-01T00:00:00.000Z",
          };
        },
        async countActiveByEnvelope() {
          return 0;
        },
        async list() {
          return [];
        },
      } as never,
      envelopes: {
        async tryAdmitRuns() {
          return true;
        },
        async releaseRuns(_id: string, _tenant: string, requestId: string) {
          released = requestId;
        },
        async admit() {},
        async settle() {},
        async spend() {
          return { usd: 0, runs: 0 };
        },
      } as never,
      newId: () => "sc-lost",
    });
    await expect(
      service.submit({
        tenant: "acme",
        dataset: { id: "d", version: "1.0.0" },
        harness: { id: "cli", version: "1.0.0" },
        origin: { source: "agent", causedByRunId: "run-parent" } as never,
      }),
    ).rejects.toThrow(/database was unavailable/);
    // The right went back under the SAME request identity it was claimed with — idempotent, so a duplicate
    // release is a no-op rather than a refund.
    expect(released).toBe("adm:scorecard:sc-lost");
  });

  it("holds with a JUDGE and a workspace judge default in play — the guard must not 409 every real series", async () => {
    // The equality is now load-bearing for every product auto-eval, so it has to hold on the shape those
    // actually have: a selected judge with its own floating model, plus the workspace default that governs
    // the inline judge grader. If the resolver and the manifest projection disagreed on ANY of these facets,
    // this submit would 409 and no product series with judges could ever run again.
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", dataset());
    const harnesses = new StubHarnessRegistry();
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", {
      kind: "model",
      id: "quality",
      version: "1.0.0",
      provider: "anthropic",
      model: { ref: "judge-model" },
      rubric: "good?",
      inputs: ["trace"],
      tags: [],
    });
    const resolveModelBinding = async (_t: string, b: { ref: string }) => `${b.ref}@3.0.0`;
    const judgeFor = () => ({ provider: "anthropic" as const, model: { ref: "judge-model" } });
    const withJudge = { ...series, judges: [{ id: "quality" }] } as unknown as ProductSeries;
    const resolution = await resolveSeriesContract(
      { datasets, harnesses, judges, resolveModelBinding, judgeFor } as unknown as SeriesContractDeps,
      "acme",
      withJudge,
    );
    if (resolution.status !== "resolved") throw new Error(resolution.status);

    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(job) {
          return {
            caseId: job.evalCase.id,
            harness: `${job.harness.id}@${job.harness.version}`,
            trace: [],
            snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
            scores: [],
          };
        },
      },
      store,
      datasets,
      harnesses,
      judges,
      resolveModelBinding,
      judgeFor,
      newId: () => "sc-judged",
    });
    const submitted = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "cli", version: "1.0.0" },
      judges: [{ id: "quality", version: "1.0.0" }],
      expectedContractDigest: resolution.digest,
    });
    expect(submitted.id).toBe("sc-judged");
  });

  it("…and proceeds untouched when nothing moved — the guard is not a blanket refusal", async () => {
    const at3 = await world("3.0.0");
    const resolution = await resolveSeriesContract(at3.deps, "acme", series);
    if (resolution.status !== "resolved") throw new Error(resolution.status);
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(job) {
          return {
            caseId: job.evalCase.id,
            harness: `${job.harness.id}@${job.harness.version}`,
            trace: [],
            snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
            scores: [],
          };
        },
      },
      store,
      datasets: at3.datasets,
      harnesses: at3.harnesses,
      resolveModelBinding: at3.resolveModelBinding,
      newId: () => "sc-held",
    });
    const submitted = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "cli", version: "1.0.0" },
      expectedContractDigest: resolution.digest,
    });
    expect(submitted.id).toBe("sc-held");
    // The record's manifest projects back onto exactly the contract the product resolved — which is the
    // property the digest equality was standing in for.
    const stored = await store.get("sc-held");
    expect(stored?.manifest?.harness?.model).toBe("agent-model@3.0.0");
  });
});
