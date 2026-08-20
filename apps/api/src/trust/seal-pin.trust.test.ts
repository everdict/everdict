import { InMemoryCaseReceiptStore, ScorecardService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { Dataset, HarnessSpec, JudgeSpec } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import {
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
} from "@everdict/registry";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { TRUST_SUITE_ENABLED } from "./trust-context.js";

// The judge port answers an INVOCATION now (arch-review 58 follow-through). This scenario has no
// trajectory to seal into, which is exactly what `not_applicable` means.
const judgeInvocation = (scores: unknown) => ({ scores, evidence: "not_applicable" }) as never;

// Trust suite (docs/trust-certification.md) — TRUST-40.
//
// THE SEAL IS THE PIN: WHAT THE MANIFEST RECORDED IS WHAT EXECUTES, EVEN WHEN THE REGISTRY MOVES MID-PASS.
// A `{ref}` binding with no version resolves `latest` at every materialization — dispatch re-resolved the
// harness's model per case, and the Temporal scoring path re-resolved judge specs per case, so the seal was
// an OBSERVATION a later resolution silently walked away from ("same manifest, different execution"). This
// is metamorphic: the registry's latest MOVES between the seal and the execution, and the execution must
// still carry the sealed resolution — certified through the production submit → dispatch lane (the executed
// harnessSpec's pinned binding) and the production score() → judge lane (the judged spec AND the ledger
// revision both carrying the pass-start closure).
const describeTrust = TRUST_SUITE_ENABLED ? describe : describe.skip;

const datasetWithCase = (): Dataset => ({
  id: "d",
  version: "1.0.0",
  cases: [
    {
      id: "c1",
      env: { kind: "repo", source: { files: { "a.txt": "x" } } },
      task: "do",
      graders: [],
      timeoutSec: 1800,
      tags: [],
    },
  ],
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

describeTrust("TRUST-40 — the registry moving mid-pass cannot change what executes or what the ledger claims", () => {
  it("the dispatched harness spec carries the SUBMIT-time model resolution, not dispatch-time latest", async () => {
    const commandSpec = {
      kind: "command",
      id: "cli",
      version: "1.0.0",
      command: "run {{task}}",
      model: { ref: "agent-model" }, // floating — resolves latest at every materialization pre-fix
      trace: { kind: "none" },
      setup: [],
      params: {},
    } as unknown as HarnessSpec;
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    let latest = "5.0.0";
    const dispatched: HarnessSpec[] = [];
    let releaseDispatch: () => void = () => {};
    const dispatchGate = new Promise<void>((r) => {
      releaseDispatch = r;
    });
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        await dispatchGate; // hold the case until the registry has MOVED — the drift window under test
        if (job.harnessSpec) dispatched.push(job.harnessSpec);
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
      store,
      datasets,
      harnesses: new StubHarnessRegistry(commandSpec),
      resolveModelBinding: async (_tenant, binding) => `${binding.ref}@${latest}`,
      newId: () => "t40-harness",
    });
    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "cli", version: "1.0.0" },
    });
    expect(record.manifest?.harness.model).toBe("agent-model@5.0.0"); // sealed at submit

    // The registry's latest MOVES before any case dispatches.
    latest = "6.0.0";
    releaseDispatch();
    for (let i = 0; i < 200 && dispatched.length === 0; i++) await new Promise((r) => setTimeout(r, 5));

    // The executed spec carries the SEAL's resolution — the binding was pinned, not re-resolved.
    expect(dispatched).toHaveLength(1);
    const executed = dispatched[0];
    expect(executed && "model" in executed ? executed.model : undefined).toEqual({
      ref: "agent-model",
      version: "5.0.0",
    });
  });

  it("a judge's moving refs judge under the PASS-START seal, and the ledger records that closure", async () => {
    const datasets = new InMemoryDatasetRegistry();
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", {
      kind: "model",
      id: "quality",
      version: "1.0.0",
      provider: "anthropic",
      model: { ref: "judge-model" }, // floating
      rubric: "good?",
      inputs: ["trace"],
      tags: [],
    } as unknown as JudgeSpec);
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    let latest = "1.0.0";
    let releaseJudge: () => void = () => {};
    const judgeGate = new Promise<void>((r) => {
      releaseJudge = r;
    });
    const judgedSpecs: JudgeSpec[] = [];
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(job) {
          return {
            caseId: job.evalCase.id,
            harness: `${job.harness.id}@${job.harness.version}`,
            trace: [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.01 } }],
            snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
            scores: [],
          };
        },
      },
      store,
      runStore,
      caseReceipts: new InMemoryCaseReceiptStore(),
      datasets,
      judges,
      judgeRunner: {
        run: async (spec) => {
          await judgeGate;
          judgedSpecs.push(spec);
          return judgeInvocation([{ graderId: `judge:${spec.id}`, metric: `judge:${spec.id}`, value: 1, pass: true }]);
        },
      },
      resolveModelBinding: async (_tenant, binding) => `${binding.ref}@${latest}`,
    });
    const record = await service.submitExperiment({
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      task: { prompt: "hi" },
    });
    for (let i = 0; i < 200; i++) {
      const rec = await store.get(record.id);
      if (rec && rec.status !== "queued" && rec.status !== "running") break;
      await new Promise((r) => setTimeout(r, 5));
    }

    // The pass starts (the marker seals judge-model@1.0.0); the ref MOVES before any case is judged.
    await service.scoreGroup({ tenant: "acme", id: record.id, judges: [{ id: "quality", version: "latest" }] });
    latest = "2.0.0";
    releaseJudge();
    const scored = await (async () => {
      for (let i = 0; i < 200; i++) {
        const rec = await store.get(record.id);
        if (rec?.scoring?.some((rev) => rev.kind === "rescore")) return rec;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("scoring did not settle");
    })();

    // The judged spec carries the sealed resolution; the ledger's revision records the pass-start closure.
    expect(judgedSpecs[0] && "model" in judgedSpecs[0] ? judgedSpecs[0].model : undefined).toEqual({
      ref: "judge-model",
      version: "1.0.0",
    });
    expect(scored.scoring?.at(-1)?.judges?.[0]).toMatchObject({ id: "quality", model: "judge-model@1.0.0" });
  });
});
