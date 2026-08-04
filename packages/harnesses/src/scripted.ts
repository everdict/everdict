import {
  type ComputeHandle,
  type EvaluableHarness,
  type RunContext,
  type TraceEvent,
  stamp,
} from "@everdict/contracts";

export interface ScriptedStep {
  tool: string;
  cmd: string;
}

export interface ScriptedOptions {
  clock?: () => number; // Event-time source; defaults to the wall clock (`Date.now`). Injected for deterministic tests.
}

// A deterministic harness — takes a task, "actually runs" a fixed set of commands on compute,
// and emits real TraceEvents from the results. A harness for proving the full eval loop with no LLM/API key.
//
// Deterministic means the STEPS are fixed, not that time stands still: the commands really run, so the trace
// is stamped from the real clock like every other harness's (a step counter made its every run look
// instantaneous and left it off the reader's timeline). Tests that need fixed stamps inject `clock`.
export class ScriptedHarness implements EvaluableHarness {
  readonly id = "scripted";
  constructor(
    readonly version: string,
    private readonly plan: (task: string) => ScriptedStep[],
    private readonly opts: ScriptedOptions = {},
  ) {}

  async install(_compute: ComputeHandle): Promise<void> {}

  async *run(compute: ComputeHandle, task: string, _ctx: RunContext): AsyncIterable<TraceEvent> {
    const now = this.opts.clock ?? (() => Date.now());
    yield { ...stamp(now), kind: "message", role: "user", text: task };

    const steps = this.plan(task);
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;
      const id = `step-${i}`;
      // The call is the span; its result nests under it, so the trace reads as a tree.
      yield { ...stamp(now), kind: "tool_call", id, name: step.tool, args: { cmd: step.cmd }, spanId: id };
      const r = await compute.exec(step.cmd, { cwd: "work" });
      yield {
        ...stamp(now),
        kind: "tool_result",
        id,
        ok: r.exitCode === 0,
        output: `${r.stdout}${r.stderr}`.slice(0, 4000),
        parentId: id,
      };
    }
    yield { ...stamp(now), kind: "message", role: "assistant", text: "done" };
  }
}
