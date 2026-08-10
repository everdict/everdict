import type { HarnessSpec, JudgeSpec, ProductSeries } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { RubricRegistry } from "../ports/rubric-registry.js";
import { type SeriesContractDeps, resolveSeriesContract } from "./series-contract.js";

// One resolution, two policies (arch-review 15 P1-5). These assertions all fail on the hand-rolled resolver
// this replaced — not because it was buggy in its own terms, but because it was a SUBSET of the manifest's
// seal, and a subset that reads "held" is worse than no answer: it is a false assurance at the one moment a
// release decides to ship.

const series: ProductSeries = {
  key: "quality",
  dataset: { id: "support" },
  harness: { id: "copilot" },
  judges: [{ id: "grader" }],
} as unknown as ProductSeries;

const serviceHarness = (): HarnessSpec =>
  ({
    kind: "service",
    id: "copilot",
    version: "1.0.0",
    services: [
      { name: "api", image: "img-a", model: { ref: "agent-model" } },
      { name: "worker", image: "img-b" },
    ],
  }) as unknown as HarnessSpec;

const harnessJudge = (): JudgeSpec => ({
  kind: "harness",
  id: "grader",
  version: "1.0.0",
  harness: { id: "grader-agent", version: "latest" },
  tags: [],
});

function deps(over: Partial<SeriesContractDeps> = {}): SeriesContractDeps {
  return {
    datasets: { versions: async () => ["1.0.0"] } as unknown as DatasetRegistry,
    harnesses: {
      versions: async () => ["1.0.0"],
      // The delegated judge agent resolves through the SAME registry — `latest` lands on 4.0.0.
      get: async (_t: string, id: string) =>
        id === "grader-agent" ? ({ version: "4.0.0" } as unknown as HarnessSpec) : serviceHarness(),
    } as unknown as HarnessInstanceRegistry,
    judges: {
      versions: async () => ["1.0.0"],
      get: async () => harnessJudge(),
    } as unknown as JudgeRegistry,
    resolveModelBinding: async (_t, b) => `${b.ref}@7.0.0`,
    ...over,
  };
}

describe("resolveSeriesContract — the release gate seals with the manifest's own functions", () => {
  it("carries a SERVICE topology's per-service model bindings, which the hand-rolled resolver could not see", async () => {
    // The old resolver read `spec.model` off any harness kind. A service harness has no top-level `model` —
    // its bindings live per service — so every service-topology product's model closure resolved to nothing
    // and the contract digest was blind to the exact reference this identity exists to pin.
    const resolution = await resolveSeriesContract(deps(), "acme", series);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.contract.serviceModels).toEqual({ api: "agent-model@7.0.0" });
  });

  it("carries a harness judge's DELEGATED agent and the judge's spec bytes", async () => {
    const resolution = await resolveSeriesContract(deps(), "acme", series);
    if (resolution.status !== "resolved") throw new Error(resolution.status);
    const sealed = resolution.contract.judgeClosure?.[0];
    // The whole agent rendering the verdict could be swapped under `latest` with every id/version above held.
    expect(sealed?.harness).toBe("grader-agent@4.0.0");
    expect(sealed?.specDigest).toEqual(expect.any(String));
  });

  it("moves the digest when a nested latest moves, and holds it when nothing did", async () => {
    const before = await resolveSeriesContract(deps(), "acme", series);
    const same = await resolveSeriesContract(deps(), "acme", series);
    const after = await resolveSeriesContract(
      deps({ resolveModelBinding: async (_t, b) => `${b.ref}@8.0.0` }),
      "acme",
      series,
    );
    if (before.status !== "resolved" || same.status !== "resolved" || after.status !== "resolved")
      throw new Error("expected resolved");
    expect(same.digest).toBe(before.digest); // stable — an identity that flaps is not an identity
    expect(after.digest).not.toBe(before.digest);
  });

  it("refuses on a hole the manifest would merely record: an unresolvable service binding", async () => {
    // The manifest seals "unresolved" and the batch still runs, because refusing there would lose the run.
    // The gate is asking whether the current question's identity is ESTABLISHED, and a hole is not an answer.
    const resolution = await resolveSeriesContract(deps({ resolveModelBinding: undefined }), "acme", series);
    expect(resolution.status).toBe("unresolvable");
    if (resolution.status !== "unresolvable") return;
    expect(resolution.reason).toContain("service 'api'");
  });

  it("refuses when a judge's spec cannot be read at all — the sealer swallows it per judge, the gate must not", async () => {
    const resolution = await resolveSeriesContract(
      deps({
        judges: {
          versions: async () => ["1.0.0"],
          get: async () => {
            throw new Error("registry down");
          },
        } as unknown as JudgeRegistry,
      }),
      "acme",
      series,
    );
    expect(resolution.status).toBe("unresolvable");
    if (resolution.status !== "unresolvable") return;
    expect(resolution.reason).toContain("could not be read");
  });

  it("carries the workspace's default judge model — the facet the gate had never compared", async () => {
    // A series names no judge override, so the inline judge grader runs under the WORKSPACE default. Switching
    // that default changes what every inline score means while every id/version in the declaration reads held
    // — the manifest sealed it, the release comparison did not.
    const withDefault = await resolveSeriesContract(
      deps({ judgeFor: () => ({ model: { ref: "judge-model" } }) }),
      "acme",
      series,
    );
    if (withDefault.status !== "resolved") throw new Error(withDefault.status);
    expect(withDefault.contract.judgeRun).toEqual({ model: "judge-model@7.0.0" });

    const moved = await resolveSeriesContract(
      deps({ judgeFor: () => ({ model: { ref: "judge-model" } }), resolveModelBinding: async (_t, b) => `${b.ref}@9` }),
      "acme",
      series,
    );
    if (moved.status !== "resolved") throw new Error(moved.status);
    expect(moved.digest).not.toBe(withDefault.digest);

    // …and a default whose binding cannot be resolved is a hole, not an absence.
    const blind = await resolveSeriesContract(
      deps({ judgeFor: () => ({ model: { ref: "judge-model" } }), resolveModelBinding: undefined }),
      "acme",
      series,
    );
    expect(blind.status).toBe("unresolvable");
  });

  it("refuses on a deleted dataset before it ever looks at the closure", async () => {
    const resolution = await resolveSeriesContract(
      deps({ datasets: { versions: async () => [] } as unknown as DatasetRegistry }),
      "acme",
      series,
    );
    expect(resolution.status).toBe("unresolvable");
    if (resolution.status !== "unresolvable") return;
    expect(resolution.reason).toContain("dataset 'support' has no versions");
  });

  it("seals a judge's latest RUBRIC ref, and refuses when the rubric registry cannot answer", async () => {
    const modelJudge: JudgeSpec = {
      kind: "model",
      id: "grader",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
      rubric: { id: "style", version: "latest" },
      inputs: ["trace"],
      tags: [],
    };
    const judges = { versions: async () => ["1.0.0"], get: async () => modelJudge } as unknown as JudgeRegistry;
    const sealed = await resolveSeriesContract(
      deps({ judges, rubrics: { get: async () => ({ version: "2.0.0" }) } as unknown as RubricRegistry }),
      "acme",
      series,
    );
    if (sealed.status !== "resolved") throw new Error(sealed.status);
    expect(sealed.contract.judgeClosure?.[0]?.rubric).toBe("style@2.0.0");

    const blind = await resolveSeriesContract(deps({ judges }), "acme", series);
    expect(blind.status).toBe("unresolvable");
    if (blind.status !== "unresolvable") return;
    expect(blind.reason).toContain("rubric");
  });
});
