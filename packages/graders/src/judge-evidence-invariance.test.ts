import type { GradeContext, TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { costGrader, latencyGrader, stepsGrader } from "./trace-graders.js";

const OBS_NONE = { kind: "unobserved", reason: "no_environment" } as const;

// Downstream report 1.1's third assertion: the judge's execution, attached to the judged case's trace as
// judge-named `span` events RE-TIMED to the trace's last instant, must not move the judged agent's own
// cost / steps / latency measurements — the measurement plane stays the agent's.
describe("trace graders — judge evidence spans are invisible to the agent's measurements", () => {
  const agentTrace: TraceEvent[] = [
    { t: 0, kind: "message", role: "user", text: "task" },
    { t: 10, kind: "llm_call", model: "agent-model", cost: { inputTokens: 100, outputTokens: 20, usd: 0.5 } },
    { t: 40, kind: "tool_call", id: "t1", name: "bash", args: {} },
  ];
  // What the scoring service appends after judging (span kind, anchored at the trace's last t).
  const judgeSpans: TraceEvent[] = [
    {
      t: 40,
      kind: "span",
      name: "judge:q:llm_call",
      attributes: { model: "judge-model", usd: 0.02, inputTokens: 900 },
    },
    { t: 40, kind: "span", name: "judge:q:verdict", attributes: { text: "PASS" } },
  ];
  const ctx = (trace: TraceEvent[]): GradeContext =>
    ({
      case: { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
      deadlineAt: Date.now() + 60_000,
      observations: OBS_NONE,
      trace,
      snapshot: { kind: "prompt", output: "" },
    }) as GradeContext;

  it("cost, steps and latency are byte-identical with and without the judgment's evidence attached", async () => {
    const before = ctx(agentTrace);
    const after = ctx([...agentTrace, ...judgeSpans]);
    expect(await costGrader.grade(after)).toEqual(await costGrader.grade(before)); // the judge's usd never bills the agent
    expect(await stepsGrader.grade(after)).toEqual(await stepsGrader.grade(before));
    expect(await latencyGrader.grade(after)).toEqual(await latencyGrader.grade(before)); // anchored t ⇒ same span
  });
});
