import type { CaseJob, CaseResult, GradeContext, JudgeSpec, ModelSpec, RubricSpec } from "@everdict/contracts";
import { NotFoundError } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it, vi } from "vitest";
import { JudgeAuthDispatcher } from "../core/execution/judge-auth-dispatcher.js";
import { defaultJudgeRunner } from "../core/execution/judge-runner.js";
import { TRUST_SUITE_ENABLED } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-109 · TRUST-110.
//
// VERIFICATION BELONGS AT THE READ THAT PRODUCES THE BYTES ACTUALLY USED.
//
// The nested pins were verified where the judge was RESOLVED, and then every document was read AGAIN at use:
// the runner re-reads the rubric to build the prompt, re-reads the model to pick the provider and the key,
// re-reads the delegated harness to dispatch it. A shadow landing between the two reads was checked in one
// and consumed in the other — a check looking straight at a document nobody executed. The window is not
// theoretical: a batch's cases are judged over minutes, and one registry write is all it takes.
//
// So the pins travel to the seam. `pinnedDocumentMismatch` stays the single decision function; what changes
// is who calls it, and it is now everyone who turns a ref into bytes.
const describeTrust = TRUST_SUITE_ENABLED ? describe : describe.skip;

const ctx: GradeContext = {
  deadlineAt: Date.now() + 60_000, // the scoring phase's own bound
  case: { id: "c1", env: { kind: "repo", source: { files: {} } }, task: "do x", graders: [], timeoutSec: 60, tags: [] },
  trace: [{ t: 0, kind: "llm_call", model: "m" }],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
};

const rubricDoc = (text: string): RubricSpec =>
  ({ id: "bar", version: "1.0.0", text, tags: [] }) as unknown as RubricSpec;
const modelDoc = (model: string): ModelSpec =>
  ({ id: "model-x", version: "1.0.0", provider: "anthropic", model, tags: [] }) as unknown as ModelSpec;

const verdictResponse = () =>
  Promise.resolve(
    new Response(JSON.stringify({ content: [{ text: '{"pass":true,"score":1,"reason":"ok"}' }] }), { status: 200 }),
  );

describeTrust("TRUST-109 — the judge runner refuses a document that moved after the pass verified it", () => {
  it("a RUBRIC shadowed between resolution and use is refused — the rubric IS the question", async () => {
    const sealed = contentDigest(rubricDoc("fail unless the fix is complete"));
    const fetchImpl = vi.fn(() => verdictResponse());
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({ ANTHROPIC_API_KEY: "sk" }),
      // The registry now answers with a DIFFERENT document under the same ref — the shadow landed after the
      // pass read it.
      rubrics: {
        async get() {
          return rubricDoc("accept unless catastrophic");
        },
      } as never,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const spec: JudgeSpec = {
      kind: "model",
      id: "quality",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
      rubric: { id: "bar", version: "1.0.0" },
      inputs: ["trace"],
      tags: [],
    };
    const { scores } = await runner.run(spec, "acme", ctx, undefined, undefined, undefined, { rubricDigest: sealed });
    expect(scores[0]).toMatchObject({ metric: "judge:quality", status: "unmeasured" });
    expect(scores[0]?.detail).toContain("rubric");
    // The provider is never reached: a verdict under an uncertified question is worse than no verdict, and
    // it would also have been paid for.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a MODEL shadowed the same way is refused before the provider call", async () => {
    const sealed = contentDigest(modelDoc("claude-opus-4-8"));
    const fetchImpl = vi.fn(() => verdictResponse());
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({ ANTHROPIC_API_KEY: "sk" }),
      models: {
        async get() {
          return modelDoc("some-cheaper-model");
        },
      } as never,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const spec: JudgeSpec = {
      kind: "model",
      id: "quality",
      version: "1.0.0",
      provider: "anthropic",
      model: { ref: "model-x", version: "1.0.0" },
      rubric: "correct?",
      inputs: ["trace"],
      tags: [],
    };
    const { scores } = await runner.run(spec, "acme", ctx, undefined, undefined, undefined, { modelDigest: sealed });
    expect(scores[0]).toMatchObject({ metric: "judge:quality", status: "unmeasured" });
    expect(scores[0]?.detail).toContain("model");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("…and the unshadowed document judges normally — the pin is a check, not a wall", async () => {
    const doc = modelDoc("claude-opus-4-8");
    const fetchImpl = vi.fn(() => verdictResponse());
    const runner = defaultJudgeRunner({
      secretsFor: async () => ({ ANTHROPIC_API_KEY: "sk" }),
      models: {
        async get() {
          return doc;
        },
      } as never,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const spec: JudgeSpec = {
      kind: "model",
      id: "quality",
      version: "1.0.0",
      provider: "anthropic",
      model: { ref: "model-x", version: "1.0.0" },
      rubric: "correct?",
      inputs: ["trace"],
      tags: [],
    };
    const { scores } = await runner.run(spec, "acme", ctx, undefined, undefined, undefined, {
      modelDigest: contentDigest(doc),
    });
    expect(scores[0]).toMatchObject({ metric: "judge:quality", pass: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describeTrust("TRUST-116 — an unreadable delegated agent is a refusal, not a reduced execution", () => {
  const harnessJudge = (): JudgeSpec =>
    ({
      kind: "harness",
      id: "reviewer",
      version: "1.0.0",
      harness: { id: "grader-agent", version: "1.0.0" },
      rubric: "review it",
      tags: [],
    }) as unknown as JudgeSpec;

  const runnerOver = (harnesses: unknown, dispatched: CaseJob[]) =>
    defaultJudgeRunner({
      secretsFor: async () => ({ ANTHROPIC_API_KEY: "sk" }),
      harnesses: harnesses as never,
      dispatch: async (job) => {
        dispatched.push(job);
        return {
          caseId: job.evalCase.id,
          harness: "x@1",
          trace: [],
          snapshot: { kind: "prompt", output: '{"pass":true,"score":1,"reason":"ok"}' },
          scores: [],
        };
      },
    });

  it("a registry READ FAILURE under a pin refuses — it used to dispatch a specless job under the same name", async () => {
    // The old resolution had one `catch` for every failure, and it returned "as given": no spec, the ref's
    // own version. So a certified registered agent silently became a different, spec-less execution — the
    // guarantee reading `wrong document → refuse` beside `document unavailable → continue with less`.
    const dispatched: CaseJob[] = [];
    const runner = runnerOver(
      {
        async get() {
          throw new Error("registry connection reset");
        },
      },
      dispatched,
    );
    const { scores } = await runner.run(harnessJudge(), "acme", ctx, undefined, undefined, undefined, {
      harnessDigest: "sha256:sealed",
    });
    expect(scores[0]).toMatchObject({ metric: "judge:reviewer", status: "unmeasured" });
    expect(dispatched).toHaveLength(0);
  });

  it("a pinned agent that is no longer REGISTERED refuses too — absence is a mismatch, not a built-in", async () => {
    const dispatched: CaseJob[] = [];
    const runner = runnerOver(
      {
        async get() {
          throw new NotFoundError("NOT_FOUND", {}, "no such harness version");
        },
      },
      dispatched,
    );
    const { scores } = await runner.run(harnessJudge(), "acme", ctx, undefined, undefined, undefined, {
      harnessDigest: "sha256:sealed",
    });
    expect(scores[0]).toMatchObject({ status: "unmeasured" });
    expect(dispatched).toHaveLength(0);
  });

  it("…and with NO pin an unregistered agent still dispatches by id — built-in harnesses are named, not stored", async () => {
    const dispatched: CaseJob[] = [];
    const runner = runnerOver(
      {
        async get() {
          throw new NotFoundError("NOT_FOUND", {}, "no such harness version");
        },
      },
      dispatched,
    );
    await runner.run(harnessJudge(), "acme", ctx);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.harnessSpec).toBeUndefined();
  });
});

describeTrust("TRUST-110 — the RUNTIME judge model is verified where it materializes", () => {
  const job = (pin?: string): CaseJob =>
    ({
      evalCase: { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
      harness: { id: "cli", version: "1.0.0" },
      tenant: "acme",
      judge: { model: { ref: "model-x", version: "1.0.0" } },
      ...(pin ? { modelPins: { judgeRun: pin } } : {}),
    }) as unknown as CaseJob;

  const dispatcherOver = (served: ModelSpec) => {
    let dispatched = 0;
    const inner = {
      async dispatch(): Promise<CaseResult> {
        dispatched++;
        return { caseId: "c1", harness: "cli@1.0.0", trace: [], snapshot: { kind: "prompt", output: "" }, scores: [] };
      },
    };
    return {
      dispatcher: new JudgeAuthDispatcher({
        inner,
        scopedSecretsFor: async () => ({ workspace: { ANTHROPIC_API_KEY: "sk" }, user: {} }),
        models: {
          async get() {
            return served;
          },
        } as never,
      }),
      dispatched: () => dispatched,
    };
  };

  it("a shadowed judge model refuses the dispatch — an inline judge grader would have scored under it", async () => {
    // The runtime judge config applies to INLINE judge graders inside the sandbox, so this document decides
    // verdicts for every case in the batch without any registered judge being selected at all.
    const { dispatcher, dispatched } = dispatcherOver(modelDoc("some-cheaper-model"));
    await expect(dispatcher.dispatch(job(contentDigest(modelDoc("claude-opus-4-8"))))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(dispatched()).toBe(0);
  });

  it("the pinned document dispatches, and a job with no pin dispatches as before", async () => {
    const doc = modelDoc("claude-opus-4-8");
    const pinned = dispatcherOver(doc);
    await pinned.dispatcher.dispatch(job(contentDigest(doc)));
    expect(pinned.dispatched()).toBe(1);
    // Absence is "unverifiable", never agreement — and never a refusal either, or every batch sealed before
    // this generation would stop dispatching.
    const unpinned = dispatcherOver(modelDoc("anything at all"));
    await unpinned.dispatcher.dispatch(job());
    expect(unpinned.dispatched()).toBe(1);
  });
});
