import { type CaseJob, type CaseResult, ConflictError, type HarnessSpec, type ModelSpec } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { ModelResolvingDispatcher } from "../core/execution/model-resolving-dispatcher.js";
import { TRUST_SUITE_ENABLED } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-99.
//
// THE LAST HOP VERIFIES WHAT IT RESOLVED.
//
// `pinHarnessSpecToClosure` pins the model's VERSION into the binding, and a version is not an identity under
// owner-first resolution: `model-x@1` names whichever namespace answers. The dispatcher is where that binding
// finally becomes a provider, an underlying model name, a base URL and an API key — everything that decides
// what actually runs — so a shadow that lands between submit and dispatch changes the execution while the
// manifest keeps naming the model it sealed. No restart, no resume, no re-score required: the window is one
// registry write wide.
//
// The pinned digest therefore travels ON THE JOB, because the dispatcher has no other way to learn what the
// batch certified, and a mismatch is a hard refusal rather than a downgrade.
const describeTrust = TRUST_SUITE_ENABLED ? describe : describe.skip;

const modelDoc = (model: string, baseUrl?: string): ModelSpec =>
  ({
    id: "model-x",
    version: "1.0.0",
    provider: "anthropic",
    model,
    ...(baseUrl ? { baseUrl } : {}),
  }) as unknown as ModelSpec;

const commandSpec = (): HarnessSpec =>
  ({
    kind: "command",
    id: "cli",
    version: "1.0.0",
    command: "run {{task}}",
    model: { ref: "model-x", version: "1.0.0" },
    trace: { kind: "none" },
    setup: [],
    params: {},
  }) as unknown as HarnessSpec;

const jobWith = (pins?: { model?: string }): CaseJob =>
  ({
    evalCase: { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    harness: { id: "cli", version: "1.0.0" },
    tenant: "acme",
    harnessSpec: commandSpec(),
    ...(pins ? { modelPins: pins } : {}),
  }) as unknown as CaseJob;

const dispatcherOver = (served: ModelSpec) => {
  let dispatched = 0;
  const models = {
    async get() {
      return served;
    },
  } as never;
  const inner = {
    async dispatch(): Promise<CaseResult> {
      dispatched += 1;
      return {
        caseId: "c1",
        harness: "cli@1.0.0",
        trace: [],
        snapshot: { kind: "prompt", output: "" },
        scores: [],
      };
    },
  };
  return { d: new ModelResolvingDispatcher(models, inner), dispatched: () => dispatched };
};

describeTrust("TRUST-99 — a shadowed model document never reaches dispatch", () => {
  const sealedDoc = modelDoc("claude-opus-4-8");

  it("dispatches when the document is the one the batch pinned", async () => {
    const { d, dispatched } = dispatcherOver(sealedDoc);
    await d.dispatch(jobWith({ model: contentDigest(sealedDoc) }));
    expect(dispatched()).toBe(1);
  });

  it("refuses when the same ref now resolves to a different document", async () => {
    // Same id, same version — a workspace-local model registered after submit. The provider is the same; the
    // underlying model and the base URL are not, and those are what the agent actually calls.
    const { d, dispatched } = dispatcherOver(modelDoc("some-cheaper-model", "https://elsewhere"));
    await expect(d.dispatch(jobWith({ model: contentDigest(sealedDoc) }))).rejects.toBeInstanceOf(ConflictError);
    expect(dispatched()).toBe(0);
  });

  it("a job carrying no pin dispatches as before — absence is 'unverifiable', never a refusal", async () => {
    // Pre-pin batches, raw string bindings and unregistered models all arrive this way, and refusing them
    // would strand every batch sealed before this generation.
    const { d, dispatched } = dispatcherOver(modelDoc("anything at all"));
    await d.dispatch(jobWith());
    expect(dispatched()).toBe(1);
  });
});
