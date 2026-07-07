import type { GradeContext, Grader, Score } from "@everdict/core";

// ⓑ Trajectory — free from the trace (tool-call count).
export const stepsGrader: Grader = {
  id: "steps",
  async grade(ctx: GradeContext): Promise<Score> {
    const value = ctx.trace.filter((e) => e.kind === "tool_call").length;
    return { graderId: "steps", metric: "tool_calls", value };
  },
};

// ⓒ Cost — sum of llm_call cost in the trace (values filled by the LLM proxy).
export const costGrader: Grader = {
  id: "cost",
  async grade(ctx: GradeContext): Promise<Score> {
    let usd = 0;
    for (const e of ctx.trace) {
      if (e.kind === "llm_call" && e.cost) usd += e.cost.usd;
    }
    return { graderId: "cost", metric: "usd", value: usd };
  },
};

// ⓒ Latency — logical time from trace start to end.
export const latencyGrader: Grader = {
  id: "latency",
  async grade(ctx: GradeContext): Promise<Score> {
    const first = ctx.trace[0]?.t ?? 0;
    const last = ctx.trace[ctx.trace.length - 1]?.t ?? 0;
    return { graderId: "latency", metric: "span", value: last - first };
  },
};
