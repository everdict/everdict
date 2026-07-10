import type { EvalCase, TraceEvent } from "@everdict/contracts";
import { BadRequestError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { makeGraders } from "./make-graders.js";
import { TextMetricGrader } from "./text-metric.js";

const CASE: EvalCase = {
  id: "c1",
  env: { kind: "prompt" },
  task: "t",
  graders: [],
  timeoutSec: 60,
  tags: [],
};

const msg = (text: string, role: "user" | "assistant" = "assistant"): TraceEvent => ({
  t: 0,
  kind: "message",
  role,
  text,
});

const ctx = (trace: TraceEvent[]) => ({ case: CASE, trace, snapshot: { kind: "prompt" as const, output: "" } });

describe("text-metric grader (numeric metric from the agent's printed output)", () => {
  const grader = new TextMetricGrader({ pattern: "^steps: (\\d+)", metric: "agent_steps" });

  it("extracts the captured number from the final assistant message (trace:none stdout tail)", async () => {
    const score = await grader.grade(
      ctx([msg("noise"), msg("=== RESULT ===\nfinal_result: ok\nsteps: 12\nself_reported_success: True")]),
    );
    expect(score).toEqual({ graderId: "text-metric", metric: "agent_steps", value: 12 });
  });

  it("reads only the FINAL assistant message — earlier trajectory text does not count", async () => {
    const score = await grader.grade(ctx([msg("steps: 99"), msg("no numbers here")]));
    expect(score.value).toBe(0);
    expect(score.detail).toContain("did not capture");
  });

  it("a trace with no assistant message scores 0 with the reason in detail", async () => {
    const score = await grader.grade(ctx([msg("user text", "user")]));
    expect(score.value).toBe(0);
    expect(score.detail).toContain("no assistant message");
  });

  it("makeGraders wires it from a GraderSpec (data-driven — the bundle supplies pattern/metric)", async () => {
    const [g] = makeGraders([
      { id: "text-metric", config: { pattern: "^steps: (\\d+)", metric: "agent_steps", id: "bu-steps" } },
    ]);
    const score = await g?.grade(ctx([msg("steps: 7")]));
    expect(score).toEqual({ graderId: "bu-steps", metric: "agent_steps", value: 7 });
  });

  it("missing pattern/metric or an invalid regex is a BadRequest (no silent zero-scores)", () => {
    expect(() => new TextMetricGrader({ pattern: "", metric: "m" })).toThrow(BadRequestError);
    expect(() => new TextMetricGrader({ pattern: "x", metric: "" })).toThrow(BadRequestError);
    expect(() => new TextMetricGrader({ pattern: "([", metric: "m" })).toThrow(BadRequestError);
  });
});
