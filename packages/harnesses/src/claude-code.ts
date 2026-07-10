import { type ComputeHandle, type EvaluableHarness, type RunContext, type TraceEvent, shq } from "@everdict/contracts";
import { mapClaudeStreamJson } from "./stream-json.js";

export interface ClaudeCodeOptions {
  install?: boolean; // If true, npm-install the CLI into compute (e.g. a sandbox job). LocalDriver uses claude from PATH.
  workDir?: string;
}

// The real Claude Code adapter. Runs `claude -p ... --output-format stream-json` inside compute (the sandbox)
// and converts the output into normalized TraceEvents. claude uses the machine's subscription login.
export class ClaudeCodeHarness implements EvaluableHarness {
  readonly id = "claude-code";
  constructor(
    readonly version: string,
    private readonly opts: ClaudeCodeOptions = {},
  ) {}

  async install(compute: ComputeHandle): Promise<void> {
    if (this.opts.install) {
      await compute.exec(`npm i -g @anthropic-ai/claude-code@${this.version}`);
    }
  }

  async *run(compute: ComputeHandle, task: string, ctx: RunContext): AsyncIterable<TraceEvent> {
    // The claude CLI runs on the machine's subscription login — apiKeyEnv is usually empty (keys are injected only in a sandbox).
    const env: Record<string, string> = { ...ctx.apiKeyEnv };
    const cwd = this.opts.workDir ?? "work";
    const cmd = `claude -p ${shq(task)} --output-format stream-json --verbose --dangerously-skip-permissions`;
    const res = await compute.exec(cmd, { cwd, env, timeoutSec: ctx.timeoutSec });

    let t = 0;
    const nextT = () => t++;
    for (const line of res.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      for (const ev of mapClaudeStreamJson(obj, nextT)) yield ev;
    }
  }
}
