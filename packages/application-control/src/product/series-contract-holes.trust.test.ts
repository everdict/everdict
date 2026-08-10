import type { HarnessSpec, JudgeSpec, ProductSeries } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import { type SeriesContractDeps, resolveSeriesContract } from "./series-contract.js";

// Trust suite (docs/trust-certification.md) — TRUST-122.
//
// A HOLE IS NOT AN ANSWER — AND UNKNOWN ≡ UNKNOWN IS NOT EQUALITY.
//
// One resolution, two policies: the manifest records what HAPPENED (a document it could not read is recorded
// as an absent digest and the batch still runs), while the release gate asks whether today's identity is
// ESTABLISHED (a hole is not an answer). The top-level documents already obeyed that split. The NESTED ones
// did not, because both consumers shared the sealer's lossy return: an explicit `rubric@1` whose document
// could not be read came back as the ref with no digest, indistinguishable from a verified one.
//
// The consequence is worse than a missing check. The same hole appears on BOTH sides — the auto-eval stamped
// its contract from the same unreadable registry the gate now reads — so the two contracts compare EQUAL and
// the series reads FRESH on the strength of two unknowns agreeing.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const dataset = { id: "d", version: "1.0.0", cases: [], tags: [] };
const commandSpec = (): HarnessSpec =>
  ({
    kind: "command",
    id: "h",
    version: "1.0.0",
    command: "run",
    trace: { kind: "none" },
    setup: [],
    params: {},
  }) as unknown as HarnessSpec;

const judgeWithRubric = (): JudgeSpec =>
  ({
    kind: "model",
    id: "quality",
    version: "1.0.0",
    provider: "anthropic",
    model: "claude-opus-4-8",
    rubric: { id: "style", version: "1.0.0" }, // an EXPLICIT pin — the case the old code called safe
    inputs: ["trace"],
    tags: [],
  }) as unknown as JudgeSpec;

const SERIES: ProductSeries = {
  key: "quality",
  label: "Quality",
  dataset: { id: "d", version: "1.0.0" },
  harness: { id: "h", version: "1.0.0" },
  judges: [{ id: "quality", version: "1.0.0" }],
};

const deps = (over: { rubricReadable: boolean }): SeriesContractDeps =>
  ({
    datasets: {
      async get() {
        return dataset;
      },
      async versions() {
        return ["1.0.0"];
      },
    },
    harnesses: {
      async get() {
        return commandSpec();
      },
      async versions() {
        return ["1.0.0"];
      },
    } as unknown as HarnessInstanceRegistry,
    judges: {
      async get() {
        return judgeWithRubric();
      },
      async versions() {
        return ["1.0.0"];
      },
    } as unknown as JudgeRegistry,
    rubrics: {
      async get() {
        if (!over.rubricReadable) throw new Error("rubric registry unreachable");
        return { id: "style", version: "1.0.0", text: "reject on any violation" };
      },
    },
    resolveModelBinding: async (_t: string, b: { ref: string }) => `${b.ref}@1.0.0`,
  }) as unknown as SeriesContractDeps;

describeTrust("TRUST-122 — an unverifiable nested document leaves the contract unresolvable", () => {
  it("a readable closure resolves — the refusal is about the hole, not about nesting", async () => {
    const resolution = await resolveSeriesContract(deps({ rubricReadable: true }), "acme", SERIES);
    expect(resolution.status).toBe("resolved");
  });

  it("an explicit rubric whose DOCUMENT cannot be read is unresolvable, not resolved-without-a-digest", async () => {
    const resolution = await resolveSeriesContract(deps({ rubricReadable: false }), "acme", SERIES);
    expect(resolution.status).toBe("unresolvable");
    if (resolution.status !== "unresolvable") throw new Error("expected unresolvable");
    expect(resolution.reason).toContain("rubric");
  });

  it("…so two evaluations sharing that hole cannot compare EQUAL — there is no digest to agree on", async () => {
    // The dangerous shape: the auto-eval stamps its contract from the same unreadable registry the gate later
    // reads. With a digest-less "resolved" on both sides the series read fresh; with no digest at all there
    // is nothing to compare, and the gate says so instead.
    const first = await resolveSeriesContract(deps({ rubricReadable: false }), "acme", SERIES);
    const second = await resolveSeriesContract(deps({ rubricReadable: false }), "acme", SERIES);
    expect(first.status).toBe("unresolvable");
    expect(second.status).toBe("unresolvable");
  });
});
