import type { ComputeHandle, EvaluableHarness, RunContext, TraceEvent } from "@everdict/contracts";

export interface ScriptedStep {
  tool: string;
  cmd: string;
}

// A deterministic harness — takes a task, "actually runs" a fixed set of commands on compute,
// and emits real TraceEvents from the results. A harness for proving the full eval loop with no LLM/API key.
export class ScriptedHarness implements EvaluableHarness {
  readonly id = "scripted";
  constructor(
    readonly version: string,
    private readonly plan: (task: string) => ScriptedStep[],
  ) {}

  async install(_compute: ComputeHandle): Promise<void> {}

  async *run(compute: ComputeHandle, task: string, _ctx: RunContext): AsyncIterable<TraceEvent> {
    let t = 0;
    const nextT = () => t++;
    yield { t: nextT(), kind: "message", role: "user", text: task };

    const steps = this.plan(task);
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;
      const id = `step-${i}`;
      yield { t: nextT(), kind: "tool_call", id, name: step.tool, args: { cmd: step.cmd } };
      const r = await compute.exec(step.cmd, { cwd: "work" });
      yield {
        t: nextT(),
        kind: "tool_result",
        id,
        ok: r.exitCode === 0,
        output: `${r.stdout}${r.stderr}`.slice(0, 4000),
      };
    }
    yield { t: nextT(), kind: "message", role: "assistant", text: "done" };
  }
}
