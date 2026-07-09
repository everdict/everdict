import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runAgentJob } from "@everdict/agent";
import type { AgentJob, CaseResult } from "@everdict/core";
import { DockerDriver } from "@everdict/drivers";
import type { Backend, BackendCapacity, ProbeResult, Probeable } from "./backend.js";

const execFileAsync = promisify(execFile);

// A single-host docker backend — runs the job in a container of the case's env image (EvalCase.image; e.g. the official SWE-bench prebuilt).
// Rather than baking the agent into the image, it runs the harness+scoring inside via DockerDriver (environment container). Isolation is the docker container.
export class DockerBackend implements Backend, Probeable {
  readonly id = "docker";
  private readonly driver: DockerDriver;

  constructor(private readonly opts: { image?: string; maxConcurrent?: number | (() => number) } = {}) {
    this.driver = new DockerDriver(opts.image ? { defaultImage: opts.image } : {});
  }

  async capacity(): Promise<BackendCapacity> {
    const m = this.opts.maxConcurrent ?? 4;
    return { total: typeof m === "function" ? m() : m, used: 0 };
  }

  dispatch(job: AgentJob): Promise<CaseResult> {
    return runAgentJob(job, { driver: this.driver }); // run the case in a container (case.image ?? default image)
  }

  // docker daemon reachability — asks for the server version (non-zero exit if the daemon isn't running / no permission).
  async probe(): Promise<ProbeResult> {
    try {
      const { stdout } = await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"]);
      const version = stdout.trim();
      return { reachable: true, detail: version ? `docker server ${version}` : "docker daemon responded" };
    } catch (e) {
      return { reachable: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}
