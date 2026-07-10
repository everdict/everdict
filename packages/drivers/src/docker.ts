import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BadRequestError,
  type ComputeHandle,
  type ComputeSpec,
  type Driver,
  type ExecOpts,
  type ExecResult,
  InternalError,
  type RegistryAuth,
} from "@everdict/contracts";
import { dockerAuthConfigJson, imageUsesRegistryHost } from "@everdict/domain";

const pexecFile = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

// An image-launched docker container as compute — runs the case inside its own env image (e.g. the official
// SWE-bench prebuilt = repo+deps bundled). Rather than baking the agent into the image, run commands in the
// "environment container" (the official SWE-bench evaluation approach). Relative paths (cwd/path) resolve under
// base (default /everdict); absolute paths are left as-is — so both RepoEnvironment's "work" and SWE-bench's
// "/testbed" work naturally.
class DockerComputeHandle implements ComputeHandle {
  constructor(
    private readonly cid: string,
    private readonly base: string,
    private readonly echo: boolean = false,
  ) {}

  private resolve(p: string): string {
    return p.startsWith("/") ? p : `${this.base}/${p}`;
  }

  async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const args = ["exec", "-w", opts?.cwd ? this.resolve(opts.cwd) : this.base];
    for (const [k, v] of Object.entries(opts?.env ?? {})) args.push("-e", `${k}=${v}`);
    args.push(this.cid, "sh", "-c", cmd);
    // echo mode (in-job): TEE the container command's output to this process's stdio while buffering — so the
    // orchestrator job log carries a case.image harness's output AS IT RUNS (the live log tail reads it), the
    // same contract as LocalDriver({echo}). The quiet path stays on the battle-tested buffered execFile.
    if (this.echo) return execEchoDocker(args, (opts?.timeoutSec ?? 600) * 1000, cmd);
    try {
      const { stdout, stderr } = await pexecFile("docker", args, {
        timeout: (opts?.timeoutSec ?? 600) * 1000,
        maxBuffer: MAX_BUFFER,
      });
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      // docker exec propagates the container command's exit code verbatim → non-zero is a "command failure" (not an exception).
      if (typeof e.code === "number" || e.stdout !== undefined || e.stderr !== undefined) {
        return { exitCode: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
      throw new InternalError("COMPUTE_EXEC_FAILED", { cmd }, e.message);
    }
  }

  // Write a file inside the container — passed via stdin (safe for arbitrary size/escaping). Creates the parent directory.
  async writeFile(path: string, data: string): Promise<void> {
    const full = this.resolve(path);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        "docker",
        ["exec", "-i", this.cid, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", full],
        { stdio: ["pipe", "ignore", "pipe"] },
      );
      let stderr = "";
      p.stderr.on("data", (d) => {
        stderr += String(d);
      });
      p.on("error", reject);
      p.on("close", (code) =>
        code === 0 ? resolve() : reject(new InternalError("COMPUTE_EXEC_FAILED", { path }, stderr)),
      );
      p.stdin.end(data);
    });
  }

  async readFile(path: string): Promise<string> {
    const { stdout } = await pexecFile("docker", ["exec", this.cid, "cat", this.resolve(path)], {
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  }

  async dispose(): Promise<void> {
    await pexecFile("docker", ["rm", "-f", this.cid]).catch(() => {});
  }
}

// Mount host resources into the container (e.g. a self-hosted runner's codex login directory → codex in the container uses the machine login).
// source=host path (chosen by the runner, runner opt-in rather than arbitrary data), target=container path. readOnly defaults to false.
export interface DriverMount {
  source: string;
  target: string;
  readOnly?: boolean;
}

// Authenticated pull of a workspace-registry image — writes credentials only into a temporary DOCKER_CONFIG
// directory (0600) and deletes them afterward (the host ~/.docker/config.json is untouched, same discipline as
// everdict image push). Only called when the image host matches auth.host. Once the pull completes, the
// following docker run uses the local image.
export async function pullWithRegistryAuth(image: string, auth: RegistryAuth): Promise<void> {
  const configDir = await mkdtemp(join(tmpdir(), "everdict-pull-"));
  try {
    await writeFile(join(configDir, "config.json"), dockerAuthConfigJson(auth), { mode: 0o600 });
    await pexecFile("docker", ["--config", configDir, "pull", image], { maxBuffer: MAX_BUFFER }).catch((err) => {
      const e = err as { stderr?: string; message?: string };
      throw new InternalError("DRIVER_PROVISION_FAILED", { image, registry: auth.host }, e.stderr || e.message);
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

// Buffered + teed `docker exec` — same result contract as the pexecFile path (a non-zero container exit
// resolves, never throws). On timeout the docker exec child is killed and exit 124 is returned (GNU convention).
function execEchoDocker(args: string[], timeoutMs: number, cmd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_BUFFER) stdout += String(d);
      process.stdout.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_BUFFER) stderr += String(d);
      process.stderr.write(d);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: stderr + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr: timedOut ? `${stderr}\n[everdict] docker exec timed out (${cmd.slice(0, 40)}…)` : stderr,
      });
    });
  });
}

// A Driver that launches a container from an env image. Isolation is docker (the container) — for local/simple execution, separate from the strong isolation of a Backend (Nomad/K8s).
export class DockerDriver implements Driver {
  readonly id = "docker";
  private readonly base: string;
  private readonly mounts: DriverMount[];
  // defaultImage: the image to use when a case carries no image. keepAlive: the sleep argument that keeps the container alive. base: the working root for relative paths.
  // mounts: host→container bind mounts (injected by the runner — e.g. codex login). registryAuth: workspace-registry
  // pull credentials (transient, AgentJob.registryAuth) — if the image host matches, authenticated pre-pull then run.
  // Design: docs/architecture/portable-harness-runtime.md · workspace-image-registry.md.
  constructor(
    private readonly opts: {
      defaultImage?: string;
      keepAlive?: string;
      base?: string;
      mounts?: DriverMount[];
      registryAuth?: RegistryAuth;
      echo?: boolean; // TEE every exec's output to this process's stdio (in-job: the job log becomes a live feed)
    } = {},
  ) {
    this.base = opts.base ?? "/everdict";
    this.mounts = opts.mounts ?? [];
  }

  async provision(spec: ComputeSpec): Promise<ComputeHandle> {
    const image = spec.image ?? this.opts.defaultImage;
    if (!image) {
      throw new BadRequestError("BAD_REQUEST", undefined, "DockerDriver requires spec.image or defaultImage.");
    }
    // For a workspace-registry image, authenticated pre-pull (temporary DOCKER_CONFIG) — leaves no login trace on the host daemon.
    const auth = this.opts.registryAuth;
    if (auth && imageUsesRegistryHost(image, auth.host)) await pullWithRegistryAuth(image, auth);
    const keep = this.opts.keepAlive ?? "infinity";
    // Bind-mount args (-v source:target[:ro]) — come before the image.
    const mountArgs = this.mounts.flatMap((m) => ["-v", `${m.source}:${m.target}${m.readOnly ? ":ro" : ""}`]);
    // Ignore the image ENTRYPOINT/CMD + ensure the base directory + keep-alive. Commands run inside via docker exec.
    const { stdout } = await pexecFile(
      "docker",
      ["run", "-d", ...mountArgs, "--entrypoint", "sh", image, "-c", `mkdir -p ${this.base} && exec sleep ${keep}`],
      { maxBuffer: MAX_BUFFER },
    ).catch((err) => {
      const e = err as { stderr?: string; message?: string };
      throw new InternalError("DRIVER_PROVISION_FAILED", { image }, e.stderr || e.message);
    });
    return new DockerComputeHandle(stdout.trim(), this.base, this.opts.echo ?? false);
  }
}
