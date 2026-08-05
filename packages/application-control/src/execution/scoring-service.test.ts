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
  model: "gpt-5.4-mini",
  rubric: "is it good?",
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
    await service.applyJudgesToCase("acme", CASE, [JUDGE], result);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.trace.map((e) => e.kind)).toEqual(["message", "log"]);
    // The verdict still lands on the result.
    expect(result.scores.map((s) => s.metric)).toEqual(["judge:quality"]);
  });
});
