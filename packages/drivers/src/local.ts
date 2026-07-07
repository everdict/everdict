import { exec } from "node:child_process";
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
} from "@everdict/core";

const pexec = promisify(exec);
const MAX_BUFFER = 64 * 1024 * 1024;

// A dev Driver that runs on the local host (temp directory + child_process).
// Isolation is weak (shared host) — for dev/test and inside the agent. Real isolation is the Backend's job (Nomad/K8s/Windows).
class LocalComputeHandle implements ComputeHandle {
  constructor(private readonly root: string) {}

  async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const cwd = opts?.cwd ? join(this.root, opts.cwd) : this.root;
    try {
      // Create the cwd inside the sandbox on demand — prevents spawn from silently dying when the
      // environment doesn't create a directory (e.g. prompt QA cases) and the harness's default cwd ("work") is missing.
      await mkdir(cwd, { recursive: true });
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

export class LocalDriver implements Driver {
  readonly id = "local";

  async provision(_spec: ComputeSpec): Promise<ComputeHandle> {
    const root = await mkdtemp(join(tmpdir(), "everdict-"));
    return new LocalComputeHandle(root);
  }
}
