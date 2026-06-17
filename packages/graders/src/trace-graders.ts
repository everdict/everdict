import type { GradeContext, Grader, Score } from "@assay/core";

// ⓑ 궤적 — 트레이스에서 공짜로 (툴 호출 수).
export const stepsGrader: Grader = {
  id: "steps",
  async grade(ctx: GradeContext): Promise<Score> {
    const value = ctx.trace.filter((e) => e.kind === "tool_call").length;
    return { graderId: "steps", metric: "tool_calls", value };
  },
};

// ⓒ 비용 — 트레이스의 llm_call cost 합산 (LLM 프록시가 채운 값).
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

// ⓒ 지연 — 트레이스 시작~끝 논리시간.
export const latencyGrader: Grader = {
  id: "latency",
  async grade(ctx: GradeContext): Promise<Score> {
    const first = ctx.trace[0]?.t ?? 0;
    const last = ctx.trace[ctx.trace.length - 1]?.t ?? 0;
    return { graderId: "latency", metric: "span", value: last - first };
  },
};
