import { exec, type spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  BadRequestError,
  type ComputeHandle,
  type ComputeSpec,
  type Driver,
  type ExecChunk,
  type ExecOpts,
  type ExecResult,
  InternalError,
} from "@everdict/contracts";
import { chunkSinks, runSpawn, teeSinks } from "./spawn.js";

const pexec = promisify(exec);
const MAX_BUFFER = 64 * 1024 * 1024;

// A dev Driver that runs on the local host (temp directory + child_process).
// Isolation is weak (shared host) — for dev/test and inside the agent. Real isolation is the Backend's job (Nomad/K8s/Windows).
class LocalComputeHandle implements ComputeHandle {
  // The in-flight spawned child (echo tee or execStream, if any) — kept so dispose() can kill it: a cancelled run
  // disposes the compute, and a host-native child would otherwise linger orphaned (unlike the container path where
  // docker rm -f ends everything).
  private activeChild: ReturnType<typeof spawn> | undefined;

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
        return await runSpawn(cmd, {
          cwd,
          env: { ...process.env, ...opts?.env },
          detached: true,
          timeoutMs: (opts?.timeoutSec ?? 600) * 1000,
          timeoutNote: `[everdict] exec timed out after ${Math.round(opts?.timeoutSec ?? 600)}s`,
          sinks: teeSinks(),
          register: (child) => {
            this.activeChild = child;
          },
        });
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

  // Streaming exec (ComputeHandle.execStream): same result contract as exec, chunks delivered as they
  // arrive. Rides the shared spawn core (detached group + close-first settle), so dispose() during a
  // stream kills the child exactly like the echo path.
  async execStream(cmd: string, onChunk: (chunk: ExecChunk) => void, opts?: ExecOpts): Promise<ExecResult> {
    const cwd = opts?.cwd ? join(this.root, opts.cwd) : this.root;
    await mkdir(cwd, { recursive: true });
    return runSpawn(cmd, {
      cwd,
      env: { ...process.env, ...opts?.env },
      detached: true,
      timeoutMs: (opts?.timeoutSec ?? 600) * 1000,
      timeoutNote: `[everdict] exec timed out after ${Math.round(opts?.timeoutSec ?? 600)}s`,
      sinks: this.echo ? teeSinks(onChunk) : chunkSinks(onChunk),
      register: (child) => {
        this.activeChild = child;
      },
    });
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
    // Kill any still-running child (a cancelled run tears down its compute mid-exec) so the host process doesn't
    // linger orphaned; a settled/already-dead child throws ESRCH → swallowed. Then remove the sandbox directory.
    const child = this.activeChild;
    if (child?.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL"); // the whole detached group (execEcho spawns detached)
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }
    await rm(this.root, { recursive: true, force: true });
  }
}

export interface LocalDriverOptions {
  // TEE every exec's output to this process's stdio (in-job: the job log becomes a live progress feed).
  echo?: boolean;
}

export class LocalDriver implements Driver {
  readonly id = "local";
  constructor(private readonly opts: LocalDriverOptions = {}) {}

  async provision(spec: ComputeSpec): Promise<ComputeHandle> {
    // A declared world this driver cannot provide is refused BEFORE execution — running a windows case on the
    // host's linux would produce a wrong-world result that looks like a normal one.
    if (spec.os !== "linux") {
      throw new BadRequestError(
        "BAD_REQUEST",
        { os: spec.os },
        `LocalDriver provides linux only; the case declared os '${spec.os}'. Route it to a runtime that provides that world.`,
      );
    }
    // Same rule for the capability axis: a host process has no desktop world to offer an os-use case.
    // "browser" deliberately flows through — the host may have one; the harness knows, the driver cannot.
    if (spec.needs.includes("desktop")) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { needs: spec.needs },
        "LocalDriver cannot provide a desktop world (os-use case). Route it to a computer-use-capable runtime.",
      );
    }
    const root = await mkdtemp(join(tmpdir(), "everdict-"));
    return new LocalComputeHandle(root, this.opts.echo ?? false);
  }
}
