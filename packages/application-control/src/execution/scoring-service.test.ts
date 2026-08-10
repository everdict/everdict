import type { CaseResult, EvalCase, GradeContext, JudgeSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { ScoringService } from "./scoring-service.js";

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
  it("hands the judge the agent's trace WITHOUT the infra plane (placement noise must not crowd the judged window)", async () => {
    // The model judge serializes the trace verbatim into a char-capped prompt — a sealed service log tail
    // (kind infra) riding into it would push the agent's own steps out of the judged window.
    const seen: GradeContext[] = [];
    const service = new ScoringService({
      judgeRunner: {
        async run(_spec, _tenant, ctx) {
          seen.push(ctx);
          return [{ graderId: "judge", metric: "judge:quality", value: 1 }];
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
    await service.applyJudgesToCase("acme", CASE, [{ spec: JUDGE }], result);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.trace.map((e) => e.kind)).toEqual(["message", "log"]);
    // The verdict still lands on the result.
    expect(result.scores.map((s) => s.metric)).toEqual(["judge:quality"]);
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
    const stream = await service.createJudgeStream("acme", { id: "d", version: "1.0.0", cases: [CASE], tags: [] }, [
      { id: "quality", version: "1.0.0" },
    ]);
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
          return [{ graderId: "judge", metric: "judge:quality", value: 1 }];
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
          return [{ graderId: "judge", metric: "judge:quality", value: 1 }];
        },
      },
      rubrics: { get: async () => ({ id: "review-rubric", version: "7" }) as never },
      resolveModelBinding: async (_t, b) => `${b.ref}@7`,
    });
    const stream = await service.createJudgeStream("acme", { id: "d", version: "1", cases: [CASE], tags: [] }, [
      { id: "quality", version: "latest" },
    ]);
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
          return [{ graderId: "judge", metric: "judge:agentic", value: 1 }];
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
    );
    expect(seen[1]).toMatchObject({ harness: { id: "reviewer", version: "latest" } });
  });
});
