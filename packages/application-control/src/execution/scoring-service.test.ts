import type { CaseResult, EvalCase, GradeContext, JudgeSpec } from "@everdict/contracts";
import { observationTraceEvents } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { ScoringService } from "./scoring-service.js";

// The judge port answers an INVOCATION now — the verdict plus whether the judge's own execution could be
// sealed as evidence (arch-review 58 follow-through). These fakes are about the verdict, so they answer
// `not_applicable`: none of them has a trajectory store to seal into, which is exactly that value's meaning.
// A fake that still answered a bare array would be LESS capable than the port it stands in for.
const judgeInvocation = (scores: unknown) => ({ scores, evidence: "not_applicable" }) as never;

const CASE: EvalCase = {
  id: "c1",
  env: { kind: "repo", source: { files: {} } },
  task: "t",
  graders: [],
  timeoutSec: 60,
  tags: [],
};

const JUDGE: JudgeSpec = {
  kind: "model",
  id: "quality",
  version: "1.0.0",
  provider: "openai",
  model: "gpt-5.4-mini",
  rubric: "is it good?",
  inputs: ["trace"],
  tags: [],
};

describe("ScoringService — applyJudgesToCase", () => {
  it("drains the judge's traceEvents transport slot onto the judged case's trace — and the stored score keeps none of it", async () => {
    // Downstream report 1.1: the dispatched judge's only return channel is its scores, so its own execution
    // rides Score.traceEvents. The judged case's trace is where that evidence LIVES; the persisted score
    // stays a judgment, never an envelope. Re-timed to the trace's last instant so the latency grader
    // (first/last t regardless of kind) measures the same execution before and after.
    const judgeSpans = [
      { t: 99, kind: "span" as const, name: "judge:quality:llm_call", attributes: { model: "m", usd: 0.01 } },
      { t: 100, kind: "span" as const, name: "judge:quality:verdict", attributes: { text: "PASS" } },
    ];
    const service = new ScoringService({
      judgeRunner: {
        async run() {
          return judgeInvocation([
            { graderId: "judge", metric: "judge:quality", value: 1, pass: true, traceEvents: judgeSpans },
          ]);
        },
      },
    });
    const result: CaseResult = {
      caseId: "c1",
      harness: "h@1",
      trace: [
        { t: 1, kind: "message", role: "user", text: "task" },
        { t: 7, kind: "tool_call", id: "t1", name: "bash", args: {} },
      ],
      snapshot: { kind: "prompt", output: "" },
      scores: [],
    };
    await service.applyJudgesToCase(
      "acme",
      CASE,
      [{ spec: JUDGE }],
      result,
      undefined,
      undefined,
      undefined,
      undefined,
      { passId: "pass-test" },
    );
    // The judgment's evidence is on the case's trace, re-timed to the last instant (7)…
    const spans = result.trace.filter((e) => e.kind === "span");
    expect(spans).toHaveLength(2);
    for (const s of spans) expect(s.t).toBe(7);
    expect(spans.map((s) => (s.kind === "span" ? s.name : ""))).toEqual([
      "judge:quality:llm_call",
      "judge:quality:verdict",
    ]);
    // …no llm_call was added (the judge's tokens must not bill the judged agent)…
    expect(result.trace.filter((e) => e.kind === "llm_call")).toHaveLength(0);
    // …and the STORED score carries no transport slot.
    expect(result.scores).toHaveLength(1);
    expect(result.scores[0]?.traceEvents).toBeUndefined();
  });

  it("a re-score reads the observations the RUN sealed — never a silent no_environment (review wave B)", async () => {
    // The deferred/re-score path judges from the stored CaseResult, where the observation channel lives only
    // as the sealed trace events. This drives the production reader end-to-end: seal with the production
    // sealer, re-score, and the judge's context must hold the run's own account. The RED direction is the
    // mutation rung (neutralize `observationsFromTrace` in scoring-service → this test), because the reader
    // already existed — what was missing was any production test that would notice it detaching.
    const seen: GradeContext[] = [];
    const service = new ScoringService({
      judgeRunner: {
        async run(_spec: unknown, _tenant: unknown, ctx: GradeContext) {
          seen.push(ctx);
          return judgeInvocation([{ graderId: "judge", metric: "judge:quality", value: 1, pass: true }]);
        },
      } as never,
    });
    const sealedResult: CaseResult = {
      caseId: "c1",
      harness: "h@1",
      trace: [
        { t: 1, kind: "message", role: "user", text: "task" },
        ...observationTraceEvents({
          kind: "sampled",
          deltas: [{ t: 500, kind: "repo-diff", text: "+++ b/answer.txt" }],
        }),
      ],
      snapshot: { kind: "prompt", output: "" },
      scores: [],
    };
    await service.applyJudgesToCase(
      "acme",
      CASE,
      [{ spec: JUDGE }],
      sealedResult,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        passId: "pass-test",
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.observations).toEqual({
      kind: "sampled",
      deltas: [{ t: 500, kind: "repo-diff", text: "+++ b/answer.txt" }],
    });
  });

  it("hands the judge the agent's trace WITHOUT the infra plane (placement noise must not crowd the judged window)", async () => {
    // The model judge serializes the trace verbatim into a char-capped prompt — a sealed service log tail
    // (kind infra) riding into it would push the agent's own steps out of the judged window.
    const seen: GradeContext[] = [];
    const service = new ScoringService({
      judgeRunner: {
        async run(_spec, _tenant, ctx) {
          seen.push(ctx);
          return judgeInvocation([{ graderId: "judge", metric: "judge:quality", value: 1 }]);
        },
      },
    });
    const result: CaseResult = {
      caseId: "c1",
      harness: "h@1",
      trace: [
        { t: 0, kind: "message", role: "assistant", text: "done" },
        { t: 1, kind: "infra", scope: "placement", event: "accepted", message: "case accepted" },
        { t: 2, kind: "infra", scope: "service", service: "redis", event: "logs", message: "x".repeat(8_000) },
        { t: 3, kind: "log", stream: "stderr", text: "harness stderr stays — it is the agent's own evidence" },
      ],
      snapshot: { kind: "prompt", output: "" },
      scores: [],
    };
    await service.applyJudgesToCase(
      "acme",
      CASE,
      [{ spec: JUDGE }],
      result,
      undefined,
      undefined,
      undefined,
      undefined,
      { passId: "pass-test" },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.trace.map((e) => e.kind)).toEqual(["message", "log"]);
    // The verdict still lands on the result.
    expect(result.scores.map((s) => s.metric)).toEqual(["judge:quality"]);
  });

  it("a PRIOR judgment's judge:* spans never re-enter the next judge's input — a re-score cannot read revision N-1's verdict (arch-review 41 P0-verdict)", async () => {
    // Given a stored trace that already carries a prior pass's judgment evidence (the drain above put it
    // there). A re-score rebuilds its context from this stored trace — pre-fix, only `infra` was filtered,
    // so the new judge read the old judge's verdict text as if the agent had said it.
    const seen: GradeContext[] = [];
    const service = new ScoringService({
      judgeRunner: {
        async run(_spec, _tenant, ctx) {
          seen.push(ctx);
          return judgeInvocation([
            {
              graderId: "judge",
              metric: "judge:quality",
              value: 0,
              pass: false,
              traceEvents: [{ t: 50, kind: "span", name: "judge:quality:verdict", attributes: { text: "FAIL" } }],
            },
          ]);
        },
      },
    });
    const result: CaseResult = {
      caseId: "c1",
      harness: "h@1",
      trace: [
        { t: 0, kind: "message", role: "assistant", text: "done" },
        { t: 5, kind: "span", name: "checkout", attributes: {} }, // the agent's OWN structural span stays
        { t: 9, kind: "span", name: "judge:quality:llm_call", attributes: { model: "m" } },
        { t: 9, kind: "span", name: "judge:quality:verdict", attributes: { text: "PASS — clearly correct" } },
      ],
      snapshot: { kind: "prompt", output: "" },
      scores: [],
    };
    await service.applyJudgesToCase(
      "acme",
      CASE,
      [{ spec: JUDGE }],
      result,
      undefined,
      undefined,
      undefined,
      undefined,
      { passId: "pass-test" },
    );

    // The judge saw the execution only: the agent's message + its own span — no prior judge:* span.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.trace.map((e) => (e.kind === "span" ? e.name : e.kind))).toEqual(["message", "checkout"]);
    // The prior evidence is NOT erased from the stored trace (it is the record of revision N-1)…
    const judgeSpans = result.trace.filter((e) => e.kind === "span" && e.name.startsWith("judge:"));
    // …and the new pass appended its own verdict beside it (2 prior + 1 new).
    expect(judgeSpans).toHaveLength(3);
  });
});

describe("ScoringService — a SELECTED judge that cannot be resolved stays visible", () => {
  it("leaves an unmeasured row per gradeable case instead of silently dropping the selection", async () => {
    // Given a registry that no longer resolves the selected judge (deleted / bad version / outage) — pre-fix,
    // resolveJudges swallowed the miss and the batch settled with NO trace of a judge its manifest says was chosen.
    const registry = {
      get: async () => {
        throw new Error("judge quality@1.0.0 not found");
      },
    } as unknown as import("../ports/judge-registry.js").JudgeRegistry;
    const service = new ScoringService({
      judges: registry,
      judgeRunner: {
        async run() {
          throw new Error("must not run — nothing resolved");
        },
      },
    });
    const result: CaseResult = {
      caseId: "c1",
      harness: "h@1",
      trace: [{ t: 0, kind: "message", role: "assistant", text: "done" }],
      snapshot: { kind: "prompt", output: "" },
      scores: [],
    };

    // When the stream scores a gradeable case
    const stream = await service.createJudgeStream(
      "acme",
      { id: "d", version: "1.0.0", cases: [CASE], tags: [] },
      [{ id: "quality", version: "1.0.0" }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { passId: "pass-test" },
    );
    await stream.push(result);
    await stream.settle();

    // Then the unresolved selection is a visible, non-retryable unmeasured score — configuration work, not silence
    expect(result.scores).toHaveLength(1);
    expect(result.scores[0]).toMatchObject({
      metric: "judge:quality",
      status: "unmeasured",
      reason: "unsupported",
      retryable: false, // configuration work, not a transient error a retry could clear
      detail: expect.stringContaining("could not be resolved"),
    });
    // …and it carries no value at all: the dispatch placeholder cannot enter a mean or a passRate.
    expect(result.scores[0] !== undefined && "value" in result.scores[0]).toBe(false);
  });
});

describe("ScoringService — judge model collection (leaderboard axis + export attribution)", () => {
  const specs: Record<string, JudgeSpec> = {
    quality: JUDGE, // model judge → gpt-5.4-mini
    "code-judge": {
      kind: "code",
      id: "code-judge",
      version: "1.0.0",
      language: "python",
      code: "print('[]')",
      model: "claude-opus-4-8",
      timeoutSec: 600,
      tags: [],
    } as unknown as JudgeSpec,
    "code-no-model": {
      kind: "code",
      id: "code-no-model",
      version: "1.0.0",
      language: "node",
      code: "console.log('[]')",
      timeoutSec: 600,
      tags: [],
    } as unknown as JudgeSpec,
    agentic: {
      kind: "harness",
      id: "agentic",
      version: "1.0.0",
      harness: { id: "reviewer", version: "latest" },
      tags: [],
    } as unknown as JudgeSpec,
  };
  const service = () =>
    new ScoringService({
      judges: {
        get: async (_tenant: string, id: string) => {
          const spec = specs[id];
          if (!spec) throw new Error(`judge ${id} not found`);
          return spec;
        },
      } as unknown as import("../ports/judge-registry.js").JudgeRegistry,
      judgeRunner: {
        async run() {
          return judgeInvocation([]);
        },
      },
    });
  const sel = (id: string) => ({ id, version: "1.0.0" });

  it("collectJudgeModels includes a CODE judge's declared model (the kind==='model' predicate wrongly excluded it)", async () => {
    const models = await service().collectJudgeModels("acme", [sel("quality"), sel("code-judge")], undefined);
    expect(models).toEqual(["claude-opus-4-8", "gpt-5.4-mini"]);
  });

  it("collectJudgeModelMap maps judge id → declared model; harness judges and model-less code judges are simply absent", async () => {
    const map = await service().collectJudgeModelMap("acme", [
      sel("quality"),
      sel("code-judge"),
      sel("code-no-model"), // a code judge with no model declares nothing — nothing is fabricated for it
      sel("agentic"), // a harness judge states no model — absent, so the export falls back to the batch identity
      sel("ghost"), // a missing judge is skipped (same tolerance as applyJudges)
    ]);
    expect(map).toEqual({ quality: "gpt-5.4-mini", "code-judge": "claude-opus-4-8" });
  });

  it("the two views cannot drift: every mapped model is also on the distinct model list", async () => {
    const judges = [sel("quality"), sel("code-judge"), sel("agentic")];
    const models = await service().collectJudgeModels("acme", judges, undefined);
    const map = await service().collectJudgeModelMap("acme", judges);
    for (const label of Object.values(map)) expect(models).toContain(label);
  });
});

describe("ScoringService — a pass CONCRETIZES its judges' moving refs once (seal→pin, I6)", () => {
  const modelRefJudge = (over: Partial<JudgeSpec> = {}): JudgeSpec =>
    ({
      kind: "model",
      id: "quality",
      version: "1.0.0",
      provider: "anthropic",
      model: { ref: "judge-model" },
      rubric: { id: "review-rubric", version: "latest" },
      inputs: ["trace"],
      tags: [],
      ...over,
    }) as unknown as JudgeSpec;
  const gradeable = (): CaseResult => ({
    caseId: "c1",
    harness: "h@1",
    trace: [{ t: 0, kind: "message", role: "assistant", text: "done" }],
    snapshot: { kind: "prompt", output: "" },
    scores: [],
  });
  const registryOf = (spec: JudgeSpec) =>
    ({ get: async () => spec }) as unknown as import("../ports/judge-registry.js").JudgeRegistry;

  it("the sealed closure IS the pin — the registry moving mid-pass cannot change what judges", async () => {
    // Given a pass whose closure sealed rubric@3 and judge-model@3, while the LIVE registries already answer 9
    // (the exact Temporal drift: applyJudges re-resolved per case, so case 1 and case 100 judged differently).
    const seen: JudgeSpec[] = [];
    const service = new ScoringService({
      judges: registryOf(modelRefJudge()),
      judgeRunner: {
        async run(spec) {
          seen.push(spec);
          return judgeInvocation([{ graderId: "judge", metric: "judge:quality", value: 1 }]);
        },
      },
      rubrics: { get: async () => ({ id: "review-rubric", version: "9" }) as never },
      resolveModelBinding: async () => "judge-model@9",
    });
    const sealed = [{ id: "quality", version: "latest", model: "judge-model@3", rubric: "review-rubric@3" }];

    // When two per-case applyJudges calls run under the SAME sealed closure (the batch context carries it)
    await service.applyJudges(
      "acme",
      { id: "d", version: "1", cases: [CASE], tags: [] },
      [gradeable()],
      [{ id: "quality", version: "latest" }],
      undefined,
      "bob",
      undefined,
      sealed,
      undefined,
      { passId: "pass-test" },
    );
    await service.applyJudges(
      "acme",
      { id: "d", version: "1", cases: [CASE], tags: [] },
      [gradeable()],
      [{ id: "quality", version: "latest" }],
      undefined,
      "bob",
      undefined,
      sealed,
      undefined,
      { passId: "pass-test" },
    );

    // Then every case judged under the SEALED resolution, not the moved registry's
    expect(seen).toHaveLength(2);
    for (const spec of seen) {
      expect(spec).toMatchObject({
        model: { ref: "judge-model", version: "3" },
        rubric: { id: "review-rubric", version: "3" },
      });
    }
  });

  it("without a seal, a floating ref still pins ONCE per pass from the live registry", async () => {
    const seen: JudgeSpec[] = [];
    const service = new ScoringService({
      judges: registryOf(modelRefJudge()),
      judgeRunner: {
        async run(spec) {
          seen.push(spec);
          return judgeInvocation([{ graderId: "judge", metric: "judge:quality", value: 1 }]);
        },
      },
      rubrics: { get: async () => ({ id: "review-rubric", version: "7" }) as never },
      resolveModelBinding: async (_t, b) => `${b.ref}@7`,
    });
    const stream = await service.createJudgeStream(
      "acme",
      { id: "d", version: "1", cases: [CASE], tags: [] },
      [{ id: "quality", version: "latest" }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { passId: "pass-test" },
    );
    await stream.push(gradeable());
    await stream.settle();
    expect(seen[0]).toMatchObject({
      model: { ref: "judge-model", version: "7" },
      rubric: { id: "review-rubric", version: "7" },
    });
  });

  it("a harness judge's delegated agent pins to the sealed version; 'unresolved' seals pin nothing", async () => {
    const harnessJudge = {
      kind: "harness",
      id: "agentic",
      version: "1.0.0",
      harness: { id: "reviewer", version: "latest" },
      tags: [],
    } as unknown as JudgeSpec;
    const seen: JudgeSpec[] = [];
    const service = new ScoringService({
      judges: registryOf(harnessJudge),
      judgeRunner: {
        async run(spec) {
          seen.push(spec);
          return judgeInvocation([{ graderId: "judge", metric: "judge:agentic", value: 1 }]);
        },
      },
    });
    const sealedPinned = [{ id: "agentic", version: "latest", harness: "reviewer@2" }];
    await service.applyJudges(
      "acme",
      { id: "d", version: "1", cases: [CASE], tags: [] },
      [gradeable()],
      [{ id: "agentic", version: "latest" }],
      undefined,
      "bob",
      undefined,
      sealedPinned,
      undefined,
      { passId: "pass-test" },
    );
    expect(seen[0]).toMatchObject({ harness: { id: "reviewer", version: "2" } });

    // The honest sentinel stays floating — never parsed into a fake version.
    const sealedUnresolved = [{ id: "agentic", version: "latest", harness: "unresolved" }];
    await service.applyJudges(
      "acme",
      { id: "d", version: "1", cases: [CASE], tags: [] },
      [gradeable()],
      [{ id: "agentic", version: "latest" }],
      undefined,
      "bob",
      undefined,
      sealedUnresolved,
      undefined,
      { passId: "pass-test" },
    );
    expect(seen[1]).toMatchObject({ harness: { id: "reviewer", version: "latest" } });
  });
});
