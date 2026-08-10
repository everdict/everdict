import { ScorecardService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { CaseJob, Dataset, HarnessSpec, ModelSpec } from "@everdict/contracts";
import { InMemoryScorecardStore } from "@everdict/db";
import { contentDigest } from "@everdict/domain";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
} from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { TRUST_SUITE_ENABLED } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-107 · TRUST-108.
//
// THE SUBMIT BOUNDARY IS WHERE A BATCH'S AUTHORITY IS SETTLED, and both halves of that are production
// wiring rather than decisions. TRUST-103 certifies that `makeGraders` will not hand a constitutional name
// to a producer; this certifies the earlier, louder half — the request that asks for one is REFUSED at the
// door, so the author learns their declaration meant nothing instead of believing it took effect. And
// TRUST-99 certifies the dispatcher refuses a model document that moved; that guarantee only exists for a
// job that actually carries the pin, which is a property of each driver's job literal, not of any decision
// function.
const describeTrust = TRUST_SUITE_ENABLED ? describe : describe.skip;

const dataset = (): Dataset => ({
  id: "d",
  version: "1.0.0",
  cases: [{ id: "c1", env: { kind: "prompt" }, task: "do", graders: [], timeoutSec: 60, tags: [] }],
  tags: [],
});

class StubHarnessRegistry extends InMemoryHarnessInstanceRegistry {
  constructor(private readonly spec: HarnessSpec) {
    super(new InMemoryHarnessTemplateRegistry());
  }
  override get(): Promise<HarnessSpec> {
    return Promise.resolve(this.spec);
  }
}

describeTrust("TRUST-107 — a constitutional metric name is refused at submit, not silently ignored", () => {
  it("declaring `state` is a BAD_REQUEST that names the alternative", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", dataset());
    const service = new ScorecardService({
      dispatcher: {
        async dispatch() {
          throw new Error("a refused submit never dispatches");
        },
      },
      store: new InMemoryScorecardStore(),
      datasets,
    });
    await expect(
      service.submit({
        tenant: "acme",
        dataset: { id: "d", version: "1.0.0" },
        harness: { id: "cli", version: "1.0.0" },
        // `state` is the built-in ladder's own name. Before the refusal this declaration ALSO granted the
        // producer the right to emit it — a constitutional promotion with no `authority` field for the admin
        // gate to see, which is the shape of every authority defect this codebase has had.
        graders: [{ id: "script", metrics: [{ id: "state" }] }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("a judge-family name is refused the same way — the root and its family are one namespace", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", dataset());
    const service = new ScorecardService({
      dispatcher: {
        async dispatch() {
          throw new Error("a refused submit never dispatches");
        },
      },
      store: new InMemoryScorecardStore(),
      datasets,
    });
    await expect(
      service.submit({
        tenant: "acme",
        dataset: { id: "d", version: "1.0.0" },
        harness: { id: "cli", version: "1.0.0" },
        graders: [{ id: "script", metrics: [{ id: "judge:quality" }] }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("…and an ordinary name with a declared authority passes the door — the refusal is narrow", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", dataset());
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(job) {
          return {
            caseId: job.evalCase.id,
            harness: `${job.harness.id}@${job.harness.version}`,
            trace: [],
            snapshot: { kind: "prompt", output: "done" },
            scores: [],
          };
        },
      },
      store: new InMemoryScorecardStore(),
      datasets,
      newId: () => "t107-ok",
    });
    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "cli", version: "1.0.0" },
      graders: [{ id: "script", metrics: [{ id: "business_check", authority: "ground_truth" }] }],
      submitterRoles: ["admin"],
    });
    expect(record.id).toBe("t107-ok");
  });
});

describeTrust("TRUST-108 — the in-process driver's job carries the same model pins the Temporal one does", () => {
  it("the dispatched job carries the sealed model DOCUMENT digest, not merely its ref", async () => {
    const modelSpec = {
      id: "model-x",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-x",
    } as unknown as ModelSpec;
    const commandSpec = {
      kind: "command",
      id: "cli",
      version: "1.0.0",
      command: "run {{task}}",
      model: { ref: "model-x", version: "1.0.0" },
      trace: { kind: "none" },
      setup: [],
      params: {},
    } as unknown as HarnessSpec;
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", dataset());
    const jobs: CaseJob[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        jobs.push(job);
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "prompt", output: "done" },
          scores: [],
        };
      },
    };
    const service = new ScorecardService({
      dispatcher,
      store: new InMemoryScorecardStore(),
      datasets,
      harnesses: new StubHarnessRegistry(commandSpec),
      models: {
        async get() {
          return modelSpec;
        },
      } as never,
      newId: () => "t108",
    });
    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "cli", version: "1.0.0" },
    });
    const sealed = record.manifest?.harness.modelDigest;
    expect(sealed).toBe(contentDigest(modelSpec));

    for (let i = 0; i < 200 && jobs.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(jobs).toHaveLength(1);
    // Pre-fix this was undefined on the in-process lane and populated on the Temporal one, so the SAME batch
    // was verifiable or not depending on a deployment choice the submitter never made.
    expect(jobs[0]?.modelPins?.model).toBe(sealed);
  });
});
