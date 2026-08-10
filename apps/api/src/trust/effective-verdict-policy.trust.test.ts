import { ScorecardService } from "@everdict/application-control";
import type { CaseResult, Dataset } from "@everdict/contracts";
import { InMemoryScorecardStore } from "@everdict/db";
import { caseVerdict } from "@everdict/domain";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { TRUST_SUITE_ENABLED } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-113 · TRUST-114.
//
// A DECLARATION IS NOT PART OF THE CONSTITUTION UNTIL THE DECISION FUNCTION THAT CONSUMES THE MEASUREMENT
// ALSO CONSUMES THAT DECLARATION.
//
// `GraderSpec.metrics[]` declares what a grader MEASURES and what that measurement means. `makeGraders` read
// it (granting the right to emit the metric) and the verdict policy did not — it was composed from the
// REQUEST's grading plan alone, so a declaration living in the dataset never reached the decision. A dataset
// saying "toxicity is observational" therefore produced a batch in which toxicity DECIDED the case, because
// `evaluateVerdict` excludes what the policy calls observational and falls back to any measured metric it has
// never heard of. The declaration was not merely dropped; it was inverted.
//
// Product watch series run dataset defaults, so this is the normal path to a shipped claim, not an edge.
const describeTrust = TRUST_SUITE_ENABLED ? describe : describe.skip;

const observationalDataset = (): Dataset => ({
  id: "d",
  version: "1.0.0",
  cases: [
    {
      id: "c1",
      env: { kind: "prompt" },
      task: "do",
      // The ONLY grader on the case, and it declares itself verdict-inert.
      graders: [{ id: "probe", metrics: [{ id: "toxicity", authority: "observational" }] }],
      timeoutSec: 60,
      tags: [],
    },
  ],
  tags: [],
});

const scored = (): CaseResult => ({
  caseId: "c1",
  harness: "cli@1.0.0",
  trace: [],
  snapshot: { kind: "prompt", output: "done" },
  // A measured, FAILING row under the observational name — the shape that used to decide the case.
  scores: [{ graderId: "probe", metric: "toxicity", value: 0, pass: false }],
});

function serviceOver(datasets: InMemoryDatasetRegistry, store: InMemoryScorecardStore, id: string) {
  return new ScorecardService({
    dispatcher: {
      async dispatch() {
        return scored();
      },
    },
    store,
    datasets,
    newId: () => id,
  });
}

describeTrust("TRUST-113 — a dataset's observational declaration decides nothing", () => {
  it("the batch's stamped policy carries the dataset's own semantics", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", observationalDataset());
    const store = new InMemoryScorecardStore();
    const record = await serviceOver(datasets, store, "t113").submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "cli", version: "1.0.0" },
    });
    // The policy is COMPOSED (not the bare ladder) and it classifies the metric the dataset declared.
    const policy = record.manifest?.verdictPolicy;
    expect(policy?.id).toBe("composed");
    expect(
      policy?.metrics.some(
        (m) => "metric" in m.match && m.match.metric === "toxicity" && m.authority === "observational",
      ),
    ).toBe(true);
  });

  it("…and a FAILING observational score does not fail the case — the verdict stays unmeasured", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", observationalDataset());
    const store = new InMemoryScorecardStore();
    const service = serviceOver(datasets, store, "t113b");
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "cli", version: "1.0.0" },
    });
    for (let i = 0; i < 200; i++) {
      const rec = await store.get("t113b");
      if (rec?.status === "succeeded" || rec?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const settled = await store.get("t113b");
    // The batch really finished — a vacuous "no verdict because nothing ran" would pass the assertion below
    // while proving nothing, which is the failure mode of every timing-based settle check.
    expect(settled?.status).toBe("succeeded");
    const result = settled?.scorecard?.results[0];
    expect(result?.scores[0]).toMatchObject({ metric: "toxicity", pass: false });
    // The verdict is DERIVED under the batch's own stamped policy — the same read every release-shaped
    // surface makes — so this is the number a ship would stand on, not a test-local recomputation.
    expect(settled?.verdictSummary).toMatchObject({ verdicted: 0, failed: 0 });
    // Pre-fix: `caseVerdict` fell back to the only measured row and read FAIL — a metric declared
    // verdict-inert deciding the case, and through a product series, deciding a ship.
    expect(caseVerdict(result as never, settled?.manifest?.verdictPolicy)).toBeUndefined();
  });
});

describeTrust("TRUST-114 — two cases may not disagree about what one measurement means", () => {
  it("conflicting declarations are refused at submit, not resolved by declaration order", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", {
      id: "d2",
      version: "1.0.0",
      cases: [
        {
          id: "c1",
          env: { kind: "prompt" },
          task: "a",
          graders: [{ id: "probe", metrics: [{ id: "toxicity", authority: "observational" }] }],
          timeoutSec: 60,
          tags: [],
        },
        {
          id: "c2",
          env: { kind: "prompt" },
          task: "b",
          graders: [{ id: "probe", metrics: [{ id: "toxicity", authority: "objective" }] }],
          timeoutSec: 60,
          tags: [],
        },
      ],
      tags: [],
    } as Dataset);
    const service = serviceOver(datasets, new InMemoryScorecardStore(), "t114");
    await expect(
      service.submit({
        tenant: "acme",
        dataset: { id: "d2", version: "1.0.0" },
        harness: { id: "cli", version: "1.0.0" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("an explicit run-time plan is the way out — it replaces every case's declaration", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", observationalDataset());
    const record = await serviceOver(datasets, new InMemoryScorecardStore(), "t114b").submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "cli", version: "1.0.0" },
      graders: [{ id: "probe", metrics: [{ id: "toxicity", authority: "objective" }] }],
      submitterRoles: ["admin"],
    });
    const policy = record.manifest?.verdictPolicy;
    expect(
      policy?.metrics.some((m) => "metric" in m.match && m.match.metric === "toxicity" && m.authority === "objective"),
    ).toBe(true);
    expect(
      policy?.metrics.some(
        (m) => "metric" in m.match && m.match.metric === "toxicity" && m.authority === "observational",
      ),
    ).toBe(false);
  });
});
