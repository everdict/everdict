import { BadRequestError, type GradeContext, type Grader, type Score } from "@everdict/core";

// ⓑ Trajectory (trace-family) — recover a numeric metric from the agent's own printed output.
// A trace:none command harness emits no tool_call/llm_call events, so steps/cost graders read 0 — but the
// harness's stdout tail (the final assistant message, per the trace:none contract) often carries the number
// (e.g. browser-use prints "steps: 12" in its result block). This grader extracts it declaratively:
// config { pattern (regex with ONE capture group), metric, id? } — data-driven, supplied by the benchmark/bundle,
// so no per-agent code lands in core.
export class TextMetricGrader implements Grader {
  readonly id: string;
  private readonly re: RegExp;

  constructor(private readonly opts: { pattern: string; metric: string; id?: string }) {
    if (!opts.pattern) {
      throw new BadRequestError("BAD_REQUEST", { grader: "text-metric" }, "text-metric requires config.pattern.");
    }
    if (!opts.metric) {
      throw new BadRequestError("BAD_REQUEST", { grader: "text-metric" }, "text-metric requires config.metric.");
    }
    try {
      this.re = new RegExp(opts.pattern, "m");
    } catch {
      throw new BadRequestError(
        "BAD_REQUEST",
        { grader: "text-metric", pattern: opts.pattern },
        "config.pattern is not a valid regular expression.",
      );
    }
    this.id = opts.id ?? "text-metric";
  }

  async grade(ctx: GradeContext): Promise<Score> {
    // Only the FINAL assistant message speaks for the run (the stdout tail) — earlier messages are trajectory.
    for (let i = ctx.trace.length - 1; i >= 0; i--) {
      const e = ctx.trace[i];
      if (e?.kind !== "message" || e.role !== "assistant") continue;
      const m = this.re.exec(e.text);
      const value = m?.[1] === undefined ? Number.NaN : Number(m[1]);
      if (!Number.isNaN(value)) return { graderId: this.id, metric: this.opts.metric, value };
      return {
        graderId: this.id,
        metric: this.opts.metric,
        value: 0,
        detail: "pattern did not capture a number in the final assistant message",
      };
    }
    return { graderId: this.id, metric: this.opts.metric, value: 0, detail: "no assistant message in the trace" };
  }
}
