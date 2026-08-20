import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { ExecChunk, ExecResult } from "@everdict/contracts";

const MAX_BUFFER = 64 * 1024 * 1024;

// Per-stream incremental delivery. Sinks receive every chunk as it arrives; the captured buffers are
// capped at MAX_BUFFER independently (delivery is never capped — a live consumer sees the full stream).
export interface SpawnSinks {
  stdout?: (data: string) => void;
  stderr?: (data: string) => void;
}

// What a detached grandchild gets to flush after the parent exited, when nothing closes the pipes.
export const DEFAULT_EXIT_GRACE_MS = 250;

export interface RunSpawnOptions {
  // argv mode (e.g. `docker exec …`): command + args, stdin ignored. Absent → `command` is a shell line
  // (spawn {shell:true}) with default stdio, matching the local echo path exactly.
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  // Own process group, so a timeout kill reaches the shell's children too (a lingering `sleep` also holds
  // the stdio pipes open — which is why settlement is NOT on 'exit' directly, see below).
  detached?: boolean;
  timeoutMs: number;
  // Appended to stderr when the run times out (caller-flavored message; exit is 124 either way).
  timeoutNote?: string;
  sinks?: SpawnSinks;
  // Hand the child to the caller so a dispose() can kill it on cancellation.
  register?: (child: ChildProcess) => void;
  // ── HOW LONG 'exit' WAITS FOR 'close' (arch-review 58, follow-through) ───────────────────────
  //
  // A POLICY, and therefore injectable. The 250ms default is what a detached grandchild holding the pipes
  // gets before the run force-settles with whatever is buffered — the right production number, and an
  // untestable one: the test that proves late output IS captured has to lose the race deliberately, and it
  // raced the OS scheduler instead. Shrinking the child's sleep only narrowed the window; the grandchild's
  // scheduling latency is unbounded under load, so the case failed in the commit gate four separate times
  // while passing on its own.
  //
  // With the grace stated by the caller, that test asserts the MECHANISM (output flushed after exit is still
  // captured) instead of asserting that a loaded machine schedules a process within 250ms.
  exitGraceMs?: number;
}

// The shared spawn core behind every incremental exec path (echo tee + execStream). Result contract is
// exec's: a non-zero exit RESOLVES, a timeout resolves 124 (GNU convention), a spawn failure resolves 127 —
// never a throw. Settle semantics (hardened in local.ts and shared here): settle on 'close' — it fires after
// 'exit' AND all stdio has flushed, so the full output is captured (settling on 'exit' races the final
// 'data' event and drops fast-command output). 'exit' arms a 250ms grace fallback: a DETACHED grandchild
// (e.g. `sleep &`) can inherit the pipes and hold 'close' open forever — force-settle with what's buffered.
export function runSpawn(command: string, opts: RunSpawnOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = opts.args
      ? spawn(command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(command, { cwd: opts.cwd, env: opts.env, shell: true, detached: opts.detached ?? false });
    opts.register?.(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let exitGrace: ReturnType<typeof setTimeout> | undefined;
    const killHard = (): void => {
      if (opts.detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL"); // the whole group
          return;
        } catch {}
      }
      try {
        child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killHard();
    }, opts.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      const s = String(d);
      if (stdout.length < MAX_BUFFER) stdout += s;
      opts.sinks?.stdout?.(s);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = String(d);
      if (stderr.length < MAX_BUFFER) stderr += s;
      opts.sinks?.stderr?.(s);
    });
    const settle = (exitCode: number, extraStderr = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitGrace) clearTimeout(exitGrace);
      const note = timedOut && opts.timeoutNote ? `\n${opts.timeoutNote}` : "";
      resolve({ exitCode, stdout, stderr: `${stderr}${extraStderr}${note}` });
    };
    child.on("error", (e) => settle(127, String(e)));
    child.on("close", (code) => settle(timedOut ? 124 : (code ?? 1)));
    child.on("exit", (code) => {
      if (settled) return;
      exitGrace = setTimeout(() => settle(timedOut ? 124 : (code ?? 1)), opts.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS);
    });
  });
}

// Sinks that TEE to this process's stdio (echo mode: the job log carries the output as it runs) while
// optionally forwarding to an execStream consumer as well.
export function teeSinks(onChunk?: (chunk: ExecChunk) => void): SpawnSinks {
  return {
    stdout: (data) => {
      process.stdout.write(data);
      onChunk?.({ stream: "stdout", data });
    },
    stderr: (data) => {
      process.stderr.write(data);
      onChunk?.({ stream: "stderr", data });
    },
  };
}

export function chunkSinks(onChunk: (chunk: ExecChunk) => void): SpawnSinks {
  return {
    stdout: (data) => onChunk({ stream: "stdout", data }),
    stderr: (data) => onChunk({ stream: "stderr", data }),
  };
}
