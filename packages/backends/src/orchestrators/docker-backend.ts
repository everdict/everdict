import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CaseJob, CaseResult, ComputeHandle, ComputeSpec, Driver, RegistryAuth } from "@everdict/contracts";
import { DockerDriver } from "@everdict/drivers";
import { runCaseJob } from "@everdict/job-runner";
import {
  type Backend,
  type BackendCapacity,
  type DispatchOptions,
  type ProbeResult,
  type Probeable,
  dispatchAborted,
} from "../backend.js";

const execFileAsync = promisify(execFile);

// A single-host docker backend — runs the job in a container of the case's env image (EvalCase.image; e.g. the official SWE-bench prebuilt).
// Rather than baking the agent into the image, it runs the harness+scoring inside via DockerDriver (environment container). Isolation is the docker container.
export class DockerBackend implements Backend, Probeable, Driver {
  // The Driver contract's identity (the session mode below).
  readonly id = "docker";
  private readonly driver: DockerDriver;

  constructor(private readonly opts: { image?: string; maxConcurrent?: number | (() => number) } = {}) {
    this.driver = new DockerDriver(opts.image ? { defaultImage: opts.image } : {});
  }

  async capacity(): Promise<BackendCapacity> {
    const m = this.opts.maxConcurrent ?? 4;
    return { total: typeof m === "function" ? m() : m, used: 0 };
  }

  dispatch(job: CaseJob, opts?: DispatchOptions): Promise<CaseResult> {
    if (opts?.signal?.aborted) return Promise.reject(dispatchAborted(job)); // best-effort: refuse a pre-cancelled run
    opts?.onStarted?.(); // dispatch = the case begins now (past the Scheduler's wait queue) → flip the run to running
    return runCaseJob(job, { driver: this.driver }); // run the case in a container (case.image ?? default image)
  }

  // ── Session mode (agent worlds) ─────────────────────────────────────────────────────────────────────
  // The same host docker, held OPEN instead of run to completion. It is the driver this backend already owns,
  // so a session on this target and a case on this target are the same compute under two modes — which is the
  // whole point of the backend carrying the capability rather than a parallel class owning a second daemon.
  provision(spec: ComputeSpec): Promise<ComputeHandle> {
    return this.driver.provision(spec);
  }

  reap(id: string): Promise<void> {
    return this.driver.reap(id);
  }

  // Unlike a cluster placement, this one CAN reach a daemon — so a world snapshot takes the cheap path (commit
  // + push, bytes never crossing the control plane) instead of capturing over the exec channel.
  snapshot(id: string, ref: string, auth?: RegistryAuth): Promise<void> {
    return this.driver.snapshot(id, ref, auth);
  }

  // docker daemon reachability — asks for the server version (non-zero exit if the daemon isn't running / no permission).
  async probe(): Promise<ProbeResult> {
    try {
      const { stdout } = await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"]);
      const version = stdout.trim();
      return { reachable: true, detail: version ? `docker server ${version}` : "docker daemon responded" };
    } catch (e) {
      // A non-zero `docker version` almost always means the daemon isn't running / no socket permission.
      return { reachable: false, reason: "unreachable", detail: e instanceof Error ? e.message : String(e) };
    }
  }
}
