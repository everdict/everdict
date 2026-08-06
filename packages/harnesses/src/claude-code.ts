import {
  type ComputeHandle,
  type EvaluableHarness,
  type RunContext,
  type TraceEvent,
  shq,
  stamp,
} from "@everdict/contracts";
import { ChunkLineQueue } from "./line-stream.js";
import { claudeSessionId, mapClaudeStreamJson } from "./stream-json.js";

export interface ClaudeCodeOptions {
  install?: boolean; // If true, npm-install the CLI into compute (e.g. a sandbox job). LocalDriver uses claude from PATH.
  // The working directory the CLI runs in (default "work"). A CONVERSATION must keep this stable across turns —
  // claude keys its session store off the cwd, so a moving workdir silently breaks --resume.
  workDir?: string;
  // Environment a delegation profile pinned for this adapter (model connection, gateway base URL, free-form
  // vars). Merged UNDER ctx.apiKeyEnv, so a per-call credential always wins over the profile's default.
  env?: Record<string, string>;
  clock?: () => number; // Event-time source; defaults to the wall clock (`Date.now`). Injected for deterministic tests.
}

// The real Claude Code adapter. Runs `claude -p ... --output-format stream-json` inside compute (the sandbox)
// and converts the output into normalized TraceEvents. claude uses the machine's subscription login.
export class ClaudeCodeHarness implements EvaluableHarness {
  readonly id = "claude-code";
  // run() honors RunContext.conversation: `claude --resume <session-id>` continues the previous turn in the
  // SAME working directory (claude keys its session store off the cwd — the caller must keep it stable).
  readonly conversational = true as const;
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
    // Profile env first, the call's own auth env on top (a per-call credential must beat a pinned default),
    // then the forced sandbox flag.
    const env: Record<string, string> = { ...this.opts.env, ...ctx.apiKeyEnv, IS_SANDBOX: "1" };
    const cwd = this.opts.workDir ?? "work";
    // Conversation continuity: --resume picks up the previous turn's session (token captured from the
    // stream below via onToken). The resumed run mints a NEW session id — onToken keeps the last one.
    const resume = ctx.conversation?.resume;
    const cmd = `claude -p ${shq(task)}${
      resume !== undefined ? ` --resume ${shq(resume)}` : ""
    } --output-format stream-json --verbose --dangerously-skip-permissions`;
    const onToken = ctx.conversation?.onToken;

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
      for await (const line of queue) yield* this.mapLine(line, now, onToken);
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
    for (const line of res.stdout.split("\n")) yield* this.mapLine(line, now, onToken);
  }

  private *mapLine(line: string, now: () => number, onToken?: (token: string) => void): Iterable<TraceEvent> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (onToken) {
      const sid = claudeSessionId(obj);
      if (sid !== undefined) onToken(sid);
    }
    yield* mapClaudeStreamJson(obj, now);
  }
}
