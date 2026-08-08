import { ScorecardService } from "@everdict/application-control";
import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { CaseResult, ScorecardRecord } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
} from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// The gate's metric-coverage knob, END TO END. maxMetricLossFraction shipped read by the domain gate but
// reachable from nowhere: the service's effective-policy copy dropped it and the HTTP body schema omitted it,
// so the strictest possible setting was silently discarded on the only path anyone uses. These pin the whole
// chain: body schema → service copy → evaluateGate.

const dispatcher: Dispatcher = {
  async dispatch(job) {
    return {
      caseId: job.evalCase.id,
      harness: `${job.harness.id}@${job.harness.version}`,
      trace: [],
      snapshot: { kind: "prompt", output: "" },
      scores: [],
    };
  },
};

const result = (caseId: string, metrics: string[]): CaseResult => ({
  caseId,
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: metrics.map((metric) => ({ graderId: metric, metric, value: 1, pass: true })),
});

const record = (id: string, results: CaseResult[]): ScorecardRecord => ({
  id,
  tenant: "acme",
  dataset: { id: "smoke", version: "1.0.0" },
  harness: { id: "h", version: "1" },
  status: "succeeded",
  scorecard: { suiteId: "smoke", harness: "h@1", results },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

async function build() {
  const store = new InMemoryScorecardStore();
  // Baseline measures tests_pass on both cases; the candidate's grader silently emitted it on only one —
  // a 50% coverage loss the metric SETS cannot see (the metric "exists on both sides").
  await store.create(record("base", [result("a", ["tests_pass"]), result("b", ["tests_pass"])]));
  await store.create(record("cand", [result("a", ["tests_pass"]), { ...result("b", []), scores: [] } as CaseResult]));
  const app = buildServer({
    service: new RunService({ dispatcher, store: new InMemoryRunStore() }),
    scorecardService: new ScorecardService({
      dispatcher,
      store,
      datasets: new InMemoryDatasetRegistry(),
      harnesses: new InMemoryHarnessInstanceRegistry(new InMemoryHarnessTemplateRegistry()),
    }),
  });
  return app;
}

const tenant = { "x-everdict-tenant": "acme" };

describe("POST /scorecards/gate — the metric-loss knob reaches the gate", () => {
  it("maxMetricLossFraction sent over HTTP blocks the coverage loss — the knob is no longer unit-test-only", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/scorecards/gate",
      headers: tenant,
      payload: {
        baseline: "base",
        candidate: "cand",
        policy: { comparability: "allow_partial", maxMetricLossFraction: 0 },
      },
    });
    expect(res.statusCode).toBe(200);
    const decision = res.json();
    expect(decision.decision).toBe("blocked_missing");
    expect(decision.reasons.some((r: { kind: string }) => r.kind === "missing_metrics")).toBe(true);
    // The recorded decision embeds the knob — the policy that decided is the policy the caller sent.
    expect(decision.policy.maxMetricLossFraction).toBe(0);
    await app.close();
  });

  it("without the knob, allow_partial means what it says — the same loss passes on the caller's stated terms", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/scorecards/gate",
      headers: tenant,
      payload: { baseline: "base", candidate: "cand", policy: { comparability: "allow_partial" } },
    });
    expect(res.json().decision).toBe("pass");
    await app.close();
  });
});

describe("POST /scorecards/gate — experiment identity refuses a confounded pair", () => {
  const sealed = (id: string, datasetDigest: string): ScorecardRecord => ({
    ...record(id, [result("a", ["tests_pass"])]),
    manifest: {
      dataset: { id: "smoke", version: id === "base" ? "1.0.0" : "2.0.0", digest: datasetDigest },
      harness: { id: "h", version: "1" },
    },
  });

  it("a dataset whose content differs is a DIFFERENT EXPERIMENT — not_comparable until acknowledged, recorded when it is", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(sealed("base", "sha256:content-a"));
    await store.create(sealed("cand", "sha256:content-b"));
    const app = buildServer({
      service: new RunService({ dispatcher, store: new InMemoryRunStore() }),
      scorecardService: new ScorecardService({
        dispatcher,
        store,
        datasets: new InMemoryDatasetRegistry(),
        harnesses: new InMemoryHarnessInstanceRegistry(new InMemoryHarnessTemplateRegistry()),
      }),
    });
    const refused = await app.inject({
      method: "POST",
      url: "/scorecards/gate",
      headers: tenant,
      payload: { baseline: "base", candidate: "cand" },
    });
    expect(refused.json().decision).toBe("not_comparable");
    expect(refused.json().reasons[0].kind).toBe("confounded");
    expect(refused.json().evidence.regressions).toBeUndefined(); // apparatus numbers are not computed

    const acknowledged = await app.inject({
      method: "POST",
      url: "/scorecards/gate",
      headers: tenant,
      payload: { baseline: "base", candidate: "cand", policy: { allowConfounds: ["dataset_content"] } },
    });
    expect(acknowledged.json().decision).toBe("pass");
    expect(
      acknowledged
        .json()
        .reasons.some(
          (r: { kind: string; detail: string }) => r.kind === "confounded" && r.detail.includes("accepted"),
        ),
    ).toBe(true);
    expect(acknowledged.json().policy.allowConfounds).toEqual(["dataset_content"]); // recorded like a force
    await app.close();
  });
});
