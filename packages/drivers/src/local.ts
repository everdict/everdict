import { exec, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  type ComputeHandle,
  type ComputeSpec,
  type Driver,
  type ExecOpts,
  type ExecResult,
  InternalError,
} from "@everdict/contracts";

const pexec = promisify(exec);
const MAX_BUFFER = 64 * 1024 * 1024;

// A dev Driver that runs on the local host (temp directory + child_process).
// Isolation is weak (shared host) — for dev/test and inside the agent. Real isolation is the Backend's job (Nomad/K8s/Windows).
class LocalComputeHandle implements ComputeHandle {
  constructor(
    private readonly root: string,
    private readonly echo: boolean = false,
  ) {}

  async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const cwd = opts?.cwd ? join(this.root, opts.cwd) : this.root;
    try {
      // Create the cwd inside the sandbox on demand — prevents spawn from silently dying when the
      // environment doesn't create a directory (e.g. prompt QA cases) and the harness's default cwd ("work") is missing.
      await mkdir(cwd, { recursive: true });
      // echo mode (in-job): TEE the child's output to this process's stdio while buffering — the orchestrator
      // job log then carries the harness's output AS IT RUNS, which is what the live log tail reads
      // (Backend.logs). The quiet path stays on the battle-tested buffered exec.
      if (this.echo)
        return await execEcho(cmd, cwd, { ...process.env, ...opts?.env }, (opts?.timeoutSec ?? 600) * 1000);
      const { stdout, stderr } = await pexec(cmd, {
        cwd,
        env: { ...process.env, ...opts?.env },
        timeout: (opts?.timeoutSec ?? 600) * 1000,
        maxBuffer: MAX_BUFFER,
      });
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      // child_process rejects on a non-zero exit code — that is a "command failure", not an exception.
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      if (typeof e.code === "number" || e.stdout !== undefined || e.stderr !== undefined) {
        return { exitCode: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
      throw new InternalError("COMPUTE_EXEC_FAILED", { cmd }, e.message);
    }
  }

  async writeFile(path: string, data: string): Promise<void> {
    const full = join(this.root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async readFile(path: string): Promise<string> {
    return readFile(join(this.root, path), "utf8");
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

// Buffered + teed spawn — same result contract as the pexec path (non-zero exit resolves, never throws).
// On timeout the child is killed and the captured output is returned with exit 124 (GNU-timeout convention).
function execEcho(cmd: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    // detached → own process group, so a timeout kill reaches the shell's children too (a lingering child
    // like `sleep` also holds the stdio pipes open — which is why settlement is on 'exit', not 'close').
    const child = spawn(cmd, { cwd, env, shell: true, detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL"); // the whole group
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_BUFFER) stdout += String(d);
      process.stdout.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_BUFFER) stderr += String(d);
      process.stderr.write(d);
    });
    const settle = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr: timedOut ? `${stderr}\n[everdict] exec timed out after ${Math.round(timeoutMs / 1000)}s` : stderr,
      });
    };
    child.on("error", () => settle(127));
    child.on("exit", (code) => settle(timedOut ? 124 : (code ?? 1)));
  });
}

export interface LocalDriverOptions {
  // TEE every exec's output to this process's stdio (in-job: the job log becomes a live progress feed).
  echo?: boolean;
}

export class LocalDriver implements Driver {
  readonly id = "local";
  constructor(private readonly opts: LocalDriverOptions = {}) {}

  async provision(_spec: ComputeSpec): Promise<ComputeHandle> {
    const root = await mkdtemp(join(tmpdir(), "everdict-"));
    return new LocalComputeHandle(root, this.opts.echo ?? false);
  }
}
