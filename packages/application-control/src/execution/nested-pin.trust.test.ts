import type { CaseJob, HarnessSpec, JudgeSpec, ModelSpec, Score } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { ModelRegistry } from "../ports/model-registry.js";
import type { RubricRegistry } from "../ports/rubric-registry.js";
import { sealHarnessModelClosure, sealJudgeClosure } from "../scorecard/scorecard-plan.js";
import { ScoringService } from "./scoring-service.js";

// Trust suite (docs/trust-certification.md) — TRUST-96 · TRUST-97 · TRUST-98.
//
// IDENTITY IS RECURSIVE, OR IT IS NOT IDENTITY.
//
// The top-level documents each got a digest check as their own defect surfaced — dataset, harness, judge. Their
// DEPENDENCIES are the same shape one level in: a judge's rubric, its model, its delegated harness, and a
// harness's per-service models are all `{ref}` bindings read through the same owner-first lookup. `model-x@1`
// names whichever namespace answers, and everything that decides what a model IS — provider, underlying model,
// base URL, key secret — lives in the DOCUMENT, none of it in the ref. So a ref-only pin cannot detect a
// shadow at all: the string it compares is identical on both sides.
//
// Sealing "registry versions are immutable, so an explicit pin is already concrete" was the belief underneath
// this. True inside one namespace; false of the lookup that spans two.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const rubricDoc = (text: string) => ({ id: "style", version: "1.0.0", text }) as never;
const modelDoc = (model: string): ModelSpec =>
  ({ id: "model-x", version: "1.0.0", provider: "anthropic", model }) as unknown as ModelSpec;
const agentDoc = (command: string): HarnessSpec =>
  ({
    kind: "command",
    id: "grader-agent",
    version: "1.0.0",
    command,
    trace: { kind: "none" },
    setup: [],
    params: {},
  }) as unknown as HarnessSpec;

const modelJudge = (): JudgeSpec => ({
  kind: "model",
  id: "quality",
  version: "1.0.0",
  provider: "anthropic",
  model: { ref: "model-x", version: "1.0.0" }, // an EXPLICIT pin — the case the old belief called safe
  rubric: { id: "style", version: "1.0.0" },
  inputs: ["trace"],
  tags: [],
});

const world = (over: { rubric?: string; model?: string } = {}) => ({
  judges: {
    async get() {
      return modelJudge();
    },
  } as unknown as JudgeRegistry,
  rubrics: {
    async get() {
      return rubricDoc(over.rubric ?? "reject on any violation");
    },
  } as unknown as RubricRegistry,
  models: {
    async get() {
      return modelDoc(over.model ?? "claude-opus-4-8");
    },
  } as unknown as ModelRegistry,
  resolveModelBinding: async (_t: string, b: { ref: string }) => `${b.ref}@1.0.0`,
});

describeTrust("TRUST-96/97 — a shadowed NESTED document is refused before the provider is called", () => {
  it("seals the rubric and model DOCUMENTS, not just their refs", async () => {
    const [sealed] = await sealJudgeClosure(world(), "acme", [{ id: "quality", version: "1.0.0" }]);
    expect(sealed?.rubric).toBe("style@1.0.0");
    expect(sealed?.rubricDigest).toBe(contentDigest(rubricDoc("reject on any violation")));
    expect(sealed?.modelDigest).toBe(contentDigest(modelDoc("claude-opus-4-8")));
  });

  it("TRUST-96 — a shadowed RUBRIC is refused: the rubric IS the question", async () => {
    const sealed = await sealJudgeClosure(world(), "acme", [{ id: "quality", version: "1.0.0" }]);
    const shadowed = new ScoringService({
      ...world({ rubric: "accept unless catastrophic" }),
      judgeRunner: {
        async run(): Promise<Score[]> {
          throw new Error("the provider must never be reached for a shadowed rubric");
        },
      },
    });
    const { specs, unresolved } = await shadowed.resolveJudges("acme", [{ id: "quality", version: "1.0.0" }], sealed);
    expect(specs).toEqual([]);
    expect(unresolved[0]?.message).toContain("rubric");
  });

  it("TRUST-97 — a shadowed MODEL is refused: same ref, different provider/base URL/key", async () => {
    const sealed = await sealJudgeClosure(world(), "acme", [{ id: "quality", version: "1.0.0" }]);
    const shadowed = new ScoringService({
      ...world({ model: "some-cheaper-model" }),
      judgeRunner: {
        async run(): Promise<Score[]> {
          throw new Error("the provider must never be reached for a shadowed model");
        },
      },
    });
    const { specs, unresolved } = await shadowed.resolveJudges("acme", [{ id: "quality", version: "1.0.0" }], sealed);
    expect(specs).toEqual([]);
    expect(unresolved[0]?.message).toContain("model");
  });

  it("…and an unshadowed closure resolves — the pin is a check, not a wall", async () => {
    const sealed = await sealJudgeClosure(world(), "acme", [{ id: "quality", version: "1.0.0" }]);
    const same = new ScoringService({
      ...world(),
      judgeRunner: {
        async run(): Promise<Score[]> {
          return [];
        },
      },
    });
    const { specs, unresolved } = await same.resolveJudges("acme", [{ id: "quality", version: "1.0.0" }], sealed);
    expect(unresolved).toEqual([]);
    expect(specs).toHaveLength(1);
  });

  it("a closure sealed before digests existed verifies nothing rather than refusing everything", async () => {
    const legacy = [{ id: "quality", version: "1.0.0" }]; // no digests — a pre-pin generation
    const svc = new ScoringService({
      ...world({ rubric: "anything at all" }),
      judgeRunner: {
        async run(): Promise<Score[]> {
          return [];
        },
      },
    });
    const { unresolved } = await svc.resolveJudges("acme", [{ id: "quality", version: "1.0.0" }], legacy);
    expect(unresolved).toEqual([]);
  });
});

describeTrust("TRUST-111 — the delegated agent's OWN model closure is sealed, one level further down", () => {
  // A harness judge delegates the verdict to an agent. Pinning that agent's DOCUMENT says which agent judges;
  // the document then names its own `{ref}` model binding, which resolves at the judge's dispatch through the
  // same owner-first lookup that made every level above verifiable. Without this the agent is certified and
  // the model it thinks with is not — the last unpinned edge of the closure.
  const harnessJudge = (): JudgeSpec =>
    ({
      kind: "harness",
      id: "reviewer",
      version: "1.0.0",
      harness: { id: "grader-agent", version: "1.0.0" },
      rubric: "review it",
      tags: [],
    }) as unknown as JudgeSpec;

  const agentWithModel = (): HarnessSpec =>
    ({
      kind: "command",
      id: "grader-agent",
      version: "1.0.0",
      command: "review",
      model: { ref: "model-x", version: "1.0.0" },
      trace: { kind: "none" },
      setup: [],
      params: {},
    }) as unknown as HarnessSpec;

  const delegatingWorld = (over: { model?: string } = {}) => ({
    judges: {
      async get() {
        return harnessJudge();
      },
    } as unknown as JudgeRegistry,
    harnesses: {
      async get() {
        return agentWithModel();
      },
    } as unknown as HarnessInstanceRegistry,
    models: {
      async get() {
        return modelDoc(over.model ?? "claude-opus-4-8");
      },
    } as unknown as ModelRegistry,
    resolveModelBinding: async (_t: string, b: { ref: string }) => `${b.ref}@1.0.0`,
  });

  it("seals the agent document AND the model document beneath it", async () => {
    const [sealed] = await sealJudgeClosure(delegatingWorld(), "acme", [{ id: "reviewer", version: "1.0.0" }]);
    expect(sealed?.harness).toBe("grader-agent@1.0.0");
    expect(sealed?.harnessDigest).toBe(contentDigest(agentWithModel()));
    // The level the closure used to stop one short of.
    expect(sealed?.harnessModelDigest).toBe(contentDigest(modelDoc("claude-opus-4-8")));
  });

  it("the pins reach the judge as the dispatched job's model pins — detection needs a carrier", async () => {
    const sealed = await sealJudgeClosure(delegatingWorld(), "acme", [{ id: "reviewer", version: "1.0.0" }]);
    let carried: CaseJob["modelPins"];
    const service = new ScoringService({
      ...delegatingWorld(),
      judgeRunner: {
        async run(_spec, _tenant, _ctx, _placement, _submittedBy, _runId, pins): Promise<Score[]> {
          carried = pins?.harnessModelDigest !== undefined ? { model: pins.harnessModelDigest } : undefined;
          return [];
        },
      },
    });
    const { specs } = await service.resolveJudges("acme", [{ id: "reviewer", version: "1.0.0" }], sealed);
    await service.applyJudgesToCase(
      "acme",
      { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] } as never,
      specs,
      { caseId: "c1", harness: "h@1", trace: [], snapshot: { kind: "prompt", output: "" }, scores: [] } as never,
    );
    expect(carried?.model).toBe(contentDigest(modelDoc("claude-opus-4-8")));
  });
});

describeTrust("TRUST-98 — the harness's per-service model documents are pinned the same way", () => {
  const topology = (): HarnessSpec =>
    ({
      kind: "service",
      id: "topo",
      version: "1.0.0",
      services: [{ name: "api", image: "img", model: { ref: "model-x", version: "1.0.0" } }],
    }) as unknown as HarnessSpec;

  it("seals a digest per service, so a shadow under a held ref is detectable at dispatch", async () => {
    const sealed = await sealHarnessModelClosure(world(), "acme", topology());
    expect(sealed.serviceModels).toEqual({ api: "model-x@1.0.0" });
    expect(sealed.serviceModelDigests?.api).toBe(contentDigest(modelDoc("claude-opus-4-8")));
    // The command-harness form carries the same pair.
    const command = {
      kind: "command",
      id: "cli",
      version: "1",
      command: "run",
      model: { ref: "model-x" },
    } as unknown as HarnessSpec;
    const one = await sealHarnessModelClosure(world(), "acme", command);
    expect(one.model).toBe("model-x@1.0.0");
    expect(one.modelDigest).toBe(contentDigest(modelDoc("claude-opus-4-8")));
  });

  it("a raw string binding pins nothing — there is no document behind it to shadow", async () => {
    const command = {
      kind: "command",
      id: "cli",
      version: "1",
      command: "run",
      model: "claude-opus-4-8",
    } as unknown as HarnessSpec;
    const sealed = await sealHarnessModelClosure(world(), "acme", command);
    expect(sealed.model).toBe("claude-opus-4-8");
    expect(sealed.modelDigest).toBeUndefined();
  });
});
