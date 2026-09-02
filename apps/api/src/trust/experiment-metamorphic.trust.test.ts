import { ScorecardService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { Dataset, JudgeSpec } from "@everdict/contracts";
import { InMemoryScorecardStore } from "@everdict/db";
import { EXPERIMENT_AXES, experimentIdentity } from "@everdict/domain";
import { InMemoryDatasetRegistry, InMemoryEnvironmentRegistry, InMemoryJudgeRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { TRUST_SUITE_ENABLED } from "./trust-context.js";

// One shared, pinned world for the scenarios below — they are about the MANIFEST axes, and an empty results
// pair would make every one of them report an unverifiable `execution_world` too (true, and somebody else's
// scenario). See `world-axis.counterexample.test.ts` for the axis itself.
const SAME_WORLD = (() => {
  const ran = (caseId: string) =>
    ({
      caseId,
      harness: "agent@1.0.0",
      trace: [],
      snapshot: { kind: "prompt", output: "" },
      scores: [],
      execution: {
        os: "linux",
        osResolved: "declared",
        manifestVersion: 2,
        imageProvenance: { kind: "resolved", by: "driver", images: [{ ref: "img:1", digest: "sha256:img" }] },
      },
    }) as never;
  return { baseline: [ran("login")], candidate: [ran("login")] };
})();
const identity = (
  baseline: Parameters<typeof experimentIdentity>[0],
  candidate: Parameters<typeof experimentIdentity>[1],
) => experimentIdentity(baseline, candidate, SAME_WORLD);

// Trust suite (docs/trust-certification.md) — TRUST-34.
//
// METAMORPHIC IDENTITY: varying exactly ONE experiment input moves exactly ONE identity axis — measured
// through the PRODUCTION seal, end to end (submit → manifest → experimentIdentity). The domain unit tests
// exercise the axis reader over constructed manifests; this scenario refuses that shortcut, because the two
// bugs this wave fixed (the selection-keyed grading composite, the unclosed judge closure) both lived in the
// SEAL — hand-written fixtures certified an axis reader whose production inputs never had the claimed shape.
// Every manifest below is what ScorecardService.submit actually sealed.
const describeTrust = TRUST_SUITE_ENABLED ? describe : describe.skip;

const okDispatch: Dispatcher = {
  async dispatch(job) {
    return {
      caseId: job.evalCase.id,
      harness: `${job.harness.id}@${job.harness.version}`,
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
      scores: [],
    };
  },
};

// Two cases with real default graders — content and grading are separate axes only if both are populated.
const bundle = (version: string, over: { taskA?: string; gradersA?: Array<{ id: string }> } = {}): Dataset => ({
  id: "meta",
  version,
  tags: [],
  cases: [
    {
      id: "a",
      // Case `a` names its ENVIRONMENT by reference, so submit seals which world it ran against
      // (harness-definability-spec.md §2) and the `environment` axis has something to verify. An axis that
      // ABSTAINS cannot appear in "every axis holds", so a fixture with no referenced environment would
      // quietly narrow the vocabulary this scenario is derived from.
      env: { kind: "ref", id: "shop" },
      task: over.taskA ?? "translate the file",
      graders: over.gradersA ?? [{ id: "tests" }],
      timeoutSec: 60,
      tags: [],
    },
    { id: "b", env: { kind: "prompt" }, task: "fix the bug", graders: [{ id: "tests" }], timeoutSec: 60, tags: [] },
  ],
});

const judge: JudgeSpec = {
  kind: "model",
  id: "quality",
  version: "1.0.0",
  provider: "anthropic",
  model: "claude-opus-4-8",
  rubric: "good?",
  inputs: ["trace"],
  tags: [],
};

describeTrust("TRUST-34 — vary one input, move one axis (production seal, submit → manifest → identity)", () => {
  async function build() {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", bundle("1.0.0"));
    await datasets.register("acme", bundle("2.0.0", { gradersA: [{ id: "tests" }, { id: "lint" }] })); // grading-only edit
    await datasets.register("acme", bundle("3.0.0", { taskA: "translate the WHOLE file" })); // content-only edit
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", judge);
    // The world case `a` references — registered, so submit RESOLVES and seals it exactly as production does.
    const environments = new InMemoryEnvironmentRegistry();
    await environments.register("acme", {
      id: "shop",
      version: "1.0.0",
      env: { kind: "repo", source: { path: "/app" } },
    });
    let n = 0;
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store: new InMemoryScorecardStore(),
      datasets,
      judges,
      environments,
      newId: () => `meta-${++n}`,
    });
    const submit = async (over: Record<string, unknown> = {}) =>
      (
        await service.submit({
          tenant: "acme",
          dataset: { id: "meta", version: "1.0.0" },
          harness: { id: "scripted", version: "0" },
          ...over,
        })
      ).manifest;
    return { submit };
  }

  it("holds every axis when nothing varies, and moves exactly the varied axis otherwise", async () => {
    const { submit } = await build();
    const base = await submit();

    // Vary NOTHING — the same submit twice is the same experiment on every axis.
    const twin = identity(base, await submit());
    // Derived, not restated. "Every axis holds" is a claim about the VOCABULARY, and a hand-copied list turns
    // "an axis was added" into a failure that says nothing about this scenario — which is exactly what
    // happened when `execution_world` joined (arch-review 58): this file typechecked, was never run locally
    // because trust scenarios SKIP without a database, and went red on the required check instead.
    expect([...twin.held].sort()).toEqual([...EXPERIMENT_AXES].sort());
    expect(twin.confounds).toEqual([]);
    expect(twin.unverified).toEqual([]);

    // Vary ONLY the treatment (harness version) — deliberately not an identity axis.
    const treatment = identity(base, await submit({ harness: { id: "scripted", version: "1" } }));
    expect(treatment.confounds).toEqual([]);
    expect([...treatment.held].sort()).toEqual([...EXPERIMENT_AXES].sort());

    // Vary ONLY the selection (a deliberate 1-of-2 subset) — coverage's business, NO axis confounds.
    // Pre-H5 this was the defect: the selection-keyed grading composite read as a grading confound.
    const subset = identity(base, await submit({ cases: { ids: ["a"] } }));
    expect(subset.confounds).toEqual([]);
    expect(subset.held).toContain("dataset_content");
    expect(subset.held).toContain("grading_plan");

    // Vary ONLY the grading (a default-grader edit under identical content) — grading moves, content holds.
    const grading = identity(base, await submit({ dataset: { id: "meta", version: "2.0.0" } }));
    expect(grading.confounds.map((c) => c.axis)).toEqual(["grading_plan"]);
    expect(grading.held).toContain("dataset_content");

    // Vary ONLY the content (a task edit under identical graders) — content moves, grading holds.
    const content = identity(base, await submit({ dataset: { id: "meta", version: "3.0.0" } }));
    expect(content.confounds.map((c) => c.axis)).toEqual(["dataset_content"]);
    expect(content.held).toContain("grading_plan");

    // Vary ONLY the judge selection — the judge_set axis and nothing else.
    const judged = identity(base, await submit({ judges: [{ id: "quality", version: "1.0.0" }] }));
    expect(judged.confounds.map((c) => c.axis)).toEqual(["judge_set"]);
    expect(judged.held).toContain("dataset_content");
    expect(judged.held).toContain("grading_plan");
  });

  it("varies ONLY the model registry's latest under a HELD harness — the harness_model axis and nothing else (H13)", async () => {
    // The treatment's own moving reference: a command harness binding {ref} resolves latest at dispatch, so
    // the same harness id@version can execute under a different model between two submits. The production
    // seal pins the resolution; identity reads the drift as apparatus, never as the treatment.
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", bundle("1.0.0"));
    // The same shared bundle, so the same referenced environment: a deployment whose cases name a world and
    // whose service has no environment registry is REFUSED, which is the behaviour under test elsewhere.
    const environments = new InMemoryEnvironmentRegistry();
    await environments.register("acme", {
      id: "shop",
      version: "1.0.0",
      env: { kind: "repo", source: { path: "/app" } },
    });
    const commandSpec = {
      kind: "command",
      id: "cli",
      version: "1.0.0",
      command: "run {{task}}",
      model: { ref: "agent-model" },
      trace: { kind: "none" },
      setup: [],
      params: {},
    };
    let n = 0;
    let latest = "5.0.0";
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store: new InMemoryScorecardStore(),
      datasets,
      environments,
      harnesses: { get: async () => commandSpec } as unknown as ConstructorParameters<
        typeof ScorecardService
      >[0]["harnesses"],
      resolveModelBinding: async (_tenant, binding) => `${binding.ref}@${latest}`,
      newId: () => `meta-model-${++n}`,
    });
    const submit = async () =>
      (
        await service.submit({
          tenant: "acme",
          dataset: { id: "meta", version: "1.0.0" },
          harness: { id: "cli", version: "1.0.0" },
        })
      ).manifest;
    const before = await submit();
    latest = "6.0.0"; // the registry moves — nothing else does
    const after = await submit();
    const id = identity(before, after);
    expect(id.confounds.map((c) => c.axis)).toEqual(["harness_model"]);
    expect(id.confounds[0]?.detail).toContain("agent-model@5.0.0 → agent-model@6.0.0");
    expect(id.held).toContain("dataset_content");
    expect(id.held).toContain("grading_plan");
    expect(id.held).toContain("judge_set");
  });
});
