import {
  type ComputeHandle,
  type EvaluableHarness,
  type RunContext,
  type TraceEvent,
  shq,
  stamp,
} from "@everdict/contracts";
import { ChunkLineQueue } from "./line-stream.js";
import { mapClaudeStreamJson } from "./stream-json.js";

export interface ClaudeCodeOptions {
  install?: boolean; // If true, npm-install the CLI into compute (e.g. a sandbox job). LocalDriver uses claude from PATH.
  workDir?: string;
  clock?: () => number; // Event-time source; defaults to the wall clock (`Date.now`). Injected for deterministic tests.
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
    // IS_SANDBOX: the claude binary refuses --dangerously-skip-permissions as root unless it is told it runs
    // inside a sandbox — which is exactly this harness's contract (a Driver-provisioned compute; containers
    // run as root). Live-found in the playground's docker session; forced, not overridable.
    const env: Record<string, string> = { ...ctx.apiKeyEnv, IS_SANDBOX: "1" };
    const cwd = this.opts.workDir ?? "work";
    const cmd = `claude -p ${shq(task)} --output-format stream-json --verbose --dangerously-skip-permissions`;

    // Stamp real wall-clock event times so the trace aligns to the recording timeline and the latency
    // grader reflects real elapsed time — a synthetic counter made every Claude Code run's latency ≈ the
    // event count (docs/architecture/replay.md D1).
    const now = this.opts.clock ?? (() => Date.now());

    // Streaming compute (a live harness session): parse stream-json PER LINE as it arrives, so consumers
    // see tool calls while the run is still going. Same mapper, same events — only the arrival time moves.
    if (compute.execStream) {
      const queue = new ChunkLineQueue();
      const settled = compute.execStream(
        cmd,
        (chunk) => {
          if (chunk.stream === "stdout") queue.push(chunk.data);
        },
        { cwd, env, timeoutSec: ctx.timeoutSec },
      );
      settled.then(
        () => queue.end(),
        () => queue.end(), // an infra fault still unblocks the line loop; the await below propagates it
      );
      for await (const line of queue) yield* this.mapLine(line, now);
      const res = await settled;
      // The streaming path surfaces a hard CLI failure as a trace-visible error (the buffered eval path
      // parses whatever stdout carries and leaves failure classification to the case pipeline).
      if (res.exitCode !== 0) {
        yield {
          ...stamp(now),
          kind: "error",
          message: (res.stderr.trim() || `claude exited with code ${res.exitCode}`).slice(-2000),
        };
      }
      return;
    }

    const res = await compute.exec(cmd, { cwd, env, timeoutSec: ctx.timeoutSec });
    for (const line of res.stdout.split("\n")) yield* this.mapLine(line, now);
  }

  private *mapLine(line: string, now: () => number): Iterable<TraceEvent> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    yield* mapClaudeStreamJson(obj, now);
  }
}
