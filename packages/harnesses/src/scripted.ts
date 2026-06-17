import type { ComputeHandle, EvaluableHarness, RunContext, TraceEvent } from "@assay/core";

export interface ScriptedStep {
  tool: string;
  cmd: string;
}

// 결정적(deterministic) 하니스 — task를 받아 정해진 명령들을 compute에서 "실제로 실행"하고
// 그 결과로 진짜 TraceEvent를 emit한다. LLM/API 키 없이 전체 평가 루프를 증명하기 위한 하니스.
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
