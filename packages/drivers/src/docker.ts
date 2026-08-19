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
  type ExecChunk,
  type ExecOpts,
  type ExecResult,
  type ImageProvenance,
  InternalError,
  NO_IMAGE,
  type RegistryAuth,
  imageResolved,
  imageUnresolved,
} from "@everdict/contracts";
import { dockerAuthConfigJson, imageRepositoryOf, parseImageRef, pickRegistryAuth } from "@everdict/domain";
import { chunkSinks, runSpawn, teeSinks } from "./spawn.js";

const pexecFile = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

// An image-launched docker container as compute — runs the case inside its own env image (e.g. the official
// SWE-bench prebuilt = repo+deps bundled). Rather than baking the agent into the image, run commands in the
// "environment container" (the official SWE-bench evaluation approach). Relative paths (cwd/path) resolve under
// base (default /everdict); absolute paths are left as-is — so both RepoEnvironment's "work" and SWE-bench's
// "/testbed" work naturally.
class DockerComputeHandle implements ComputeHandle {
  // Exposed as the handle's identity (ComputeHandle.id): session runs persist it so a reaper in a later
  // process can still `docker rm -f` the container this process died holding.
  readonly id: string;

  constructor(
    private readonly cid: string,
    private readonly base: string,
    private readonly echo: boolean = false,
    // WHICH BYTES this container came out of, read back from the daemon at provision. Carried on the handle
    // because the driver is the only party that knows, and whoever records the world reads it from here
    // rather than from the reference the case asked for.
    readonly image: ImageProvenance = NO_IMAGE,
  ) {
    this.id = cid;
  }

  private resolve(p: string): string {
    return p.startsWith("/") ? p : `${this.base}/${p}`;
  }

  private execArgs(cmd: string, opts?: ExecOpts): string[] {
    const args = ["exec", "-w", opts?.cwd ? this.resolve(opts.cwd) : this.base];
    for (const [k, v] of Object.entries(opts?.env ?? {})) args.push("-e", `${k}=${v}`);
    args.push(this.cid, "sh", "-c", cmd);
    return args;
  }

  async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const args = this.execArgs(cmd, opts);
    // echo mode (in-job): TEE the container command's output to this process's stdio while buffering — so the
    // orchestrator job log carries a case.image harness's output AS IT RUNS (the live log tail reads it), the
    // same contract as LocalDriver({echo}). The quiet path stays on the battle-tested buffered execFile.
    if (this.echo)
      return runSpawn("docker", {
        args,
        timeoutMs: (opts?.timeoutSec ?? 600) * 1000,
        timeoutNote: `[everdict] docker exec timed out (${cmd.slice(0, 40)}…)`,
        sinks: teeSinks(),
      });
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

  // Streaming exec (ComputeHandle.execStream): same result contract as exec, chunks delivered as they
  // arrive over the shared spawn core. Echo mode additionally tees to this process's stdio.
  async execStream(cmd: string, onChunk: (chunk: ExecChunk) => void, opts?: ExecOpts): Promise<ExecResult> {
    return runSpawn("docker", {
      args: this.execArgs(cmd, opts),
      timeoutMs: (opts?.timeoutSec ?? 600) * 1000,
      timeoutNote: `[everdict] docker exec timed out (${cmd.slice(0, 40)}…)`,
      sinks: this.echo ? teeSinks(onChunk) : chunkSinks(onChunk),
    });
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

// Publish an image with a transient credential — the push twin of pullWithRegistryAuth: credentials go into a
// temporary DOCKER_CONFIG directory (0600) and are deleted afterward, the host ~/.docker/config.json untouched.
// No auth → a plain push (a dev registry with no token server).
async function pushWithRegistryAuth(ref: string, auth?: RegistryAuth): Promise<void> {
  const remap = (err: unknown): never => {
    const e = err as { stderr?: string; message?: string };
    throw new InternalError(
      "DRIVER_SNAPSHOT_FAILED",
      { ref, ...(auth !== undefined ? { registry: auth.host } : {}) },
      e.stderr || e.message,
    );
  };
  if (!auth) {
    await pexecFile("docker", ["push", ref], { maxBuffer: MAX_BUFFER }).catch(remap);
    return;
  }
  const configDir = await mkdtemp(join(tmpdir(), "everdict-push-"));
  try {
    await writeFile(join(configDir, "config.json"), dockerAuthConfigJson(auth), { mode: 0o600 });
    await pexecFile("docker", ["--config", configDir, "push", ref], { maxBuffer: MAX_BUFFER }).catch(remap);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

// ── THE DECLARED WORLD → DOCKER FLAGS (or a refusal) ────────────────────────────────────────────────
//
// Pure and exported so the refusal is testable without a docker daemon, and so a second container-launching
// driver reaches for THIS function rather than re-deriving the same mapping (a mapping written twice has
// already diverged). `label` names the refusing driver in the error the operator reads.
export function dockerWorldArgs(spec: ComputeSpec, label: string): string[] {
  const args: string[] = [];
  const resources = spec.resources;
  if (resources?.cpu !== undefined) args.push("--cpus", String(resources.cpu / 1000));
  if (resources?.memoryMb !== undefined) args.push("--memory", `${resources.memoryMb}m`);
  // Passed through rather than pre-validated: `docker run --gpus` fails loudly when the host has no GPU
  // runtime, and a loud failure is the correct outcome for a case that declared it needs one. Silently
  // dropping the flag would hand the agent a CPU-only box and score the result as a fair attempt.
  if (resources?.gpu !== undefined) args.push("--gpus", String(resources.gpu));

  const network = spec.network;
  if (network !== undefined && network.mode !== "public") {
    if (network.mode === "none") {
      args.push("--network", "none");
    } else {
      throw new BadRequestError(
        "BAD_REQUEST",
        { network: network.mode, allowedHosts: network.allowedHosts },
        `${label} cannot enforce an egress allowlist (it has no filtering network), and the case declared network mode 'allowlist'. Route it to a runtime that can filter egress, or change the declaration — running it with full network access would measure a different task.`,
      );
    }
  }
  return args;
}

// The daemon read, injected so the resolution below is testable without a docker daemon — the same reason
// `dockerWorldArgs` is exported. Returns the command's stdout; a rejection means the read did not happen.
export type DockerRead = (args: string[]) => Promise<string>;

const dockerRead: DockerRead = async (args) => (await pexecFile("docker", args, { maxBuffer: MAX_BUFFER })).stdout;

// WHICH BYTES THIS CONTAINER RUNS — asked of the CONTAINER, not of the reference.
//
// Asking the daemon "what does repo:latest resolve to?" answers a question about the registry a moment
// after the run; asking the container answers the question we need, which is what THIS execution holds.
// It also reports a stale local `latest` truthfully rather than the newer bytes a re-pull would have found.
//
// A reference that already carries a digest needs no read at all: the request itself named the bytes, and
// no lane can disagree with it. That is the fast path AND the escape a user has from a lane that cannot
// report — pin the digest and nothing has to be asked.
export async function resolveDockerImageProvenance(
  ref: string,
  containerId: string,
  read: DockerRead = dockerRead,
): Promise<ImageProvenance> {
  const requested = parseImageRef(ref).digest;
  if (requested !== undefined) return imageResolved([{ ref, digest: requested }], "ref");
  let repoDigests: string[];
  try {
    const imageId = (await read(["inspect", containerId, "--format", "{{.Image}}"])).trim();
    const raw = (await read(["image", "inspect", imageId, "--format", "{{json .RepoDigests}}"])).trim();
    const parsed: unknown = JSON.parse(raw === "" ? "[]" : raw);
    repoDigests = Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
  } catch (err) {
    // The read did not happen. This is `unknown`, not `absent` — reporting it as "this image has no digest"
    // would turn a daemon hiccup into a claim about the image (rule `protocol` L2).
    const message = err instanceof Error ? err.message : String(err);
    return imageUnresolved(
      [{ ref }],
      "inspect_failed",
      `docker could not be asked which image backs the container: ${message}`,
    );
  }
  // The read HAPPENED and the image has no registry identity — locally built, never pushed. A real answer,
  // and a different one from the failure above: nothing is wrong, there is simply nothing to name.
  const digest = pickRepoDigest(repoDigests, ref);
  if (digest === undefined)
    return imageUnresolved(
      [{ ref }],
      "no_registry_digest",
      "the image the container runs has no registry digest (built locally and never pushed), so its bytes cannot be named to another reader",
    );
  return imageResolved([{ ref, digest }], "driver");
}

// `RepoDigests` holds `repo@sha256:…` entries, one per repository the image is known by. Prefer the entry
// for the repository that was ASKED for — a mirrored image carries several, and reporting a digest under a
// repository nobody referenced would name bytes correctly and provenance wrongly.
function pickRepoDigest(repoDigests: readonly string[], ref: string): string | undefined {
  const wanted = imageRepositoryOf(ref);
  const match = repoDigests.find((d) => d.startsWith(`${wanted}@`)) ?? repoDigests[0];
  if (match === undefined) return undefined;
  const at = match.lastIndexOf("@");
  return at === -1 ? undefined : match.slice(at + 1);
}

// A Driver that launches a container from an env image. Isolation is docker (the container) — for local/simple execution, separate from the strong isolation of a Backend (Nomad/K8s).
export class DockerDriver implements Driver {
  readonly id = "docker";
  private readonly base: string;
  private readonly mounts: DriverMount[];
  // defaultImage: the image to use when a case carries no image. keepAlive: the sleep argument that keeps the container alive. base: the working root for relative paths.
  // mounts: host→container bind mounts (injected by the runner — e.g. codex login). registryAuths: image pull
  // credentials (transient, CaseJob.registryAuths) — if one covers the image's host, authenticated pre-pull then run.
  // Design: docs/architecture/portable-harness-runtime.md · managed-image-store.md.
  constructor(
    private readonly opts: {
      defaultImage?: string;
      keepAlive?: string;
      base?: string;
      mounts?: DriverMount[];
      registryAuths?: RegistryAuth[];
      echo?: boolean; // TEE every exec's output to this process's stdio (in-job: the job log becomes a live feed)
      read?: DockerRead; // the daemon read seam (image provenance) — injected in tests, real docker otherwise
    } = {},
  ) {
    this.base = opts.base ?? "/everdict";
    this.mounts = opts.mounts ?? [];
  }

  async provision(spec: ComputeSpec): Promise<ComputeHandle> {
    // A declared non-linux world is refused BEFORE execution — a linux container is not that world.
    if (spec.os !== "linux") {
      throw new BadRequestError(
        "BAD_REQUEST",
        { os: spec.os },
        `DockerDriver provides linux containers only; the case declared os '${spec.os}'.`,
      );
    }
    // A container is not a desktop either — os-use worlds live behind computer-use runtimes. "browser" flows
    // through deliberately: the IMAGE may carry headless chromium (browser-use bundles do), so the driver must
    // not refuse what the image can satisfy.
    if (spec.needs.includes("desktop")) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { needs: spec.needs },
        "DockerDriver cannot provide a desktop world (os-use case). Route it to a computer-use-capable runtime.",
      );
    }
    const image = spec.image ?? this.opts.defaultImage;
    if (!image) {
      throw new BadRequestError("BAD_REQUEST", undefined, "DockerDriver requires spec.image or defaultImage.");
    }
    // For an image one of our credentials covers, authenticated pre-pull (temporary DOCKER_CONFIG) — leaves no login trace on the host daemon.
    // Per-provision credentials win: a grant minted for THIS image (sandbox sessions) is fresher than whatever
    // the driver was built with (a job's CaseJob.registryAuths), and a driver built once at boot has none at all.
    const auth = pickRegistryAuth([...(spec.registryAuths ?? []), ...(this.opts.registryAuths ?? [])], image);
    if (auth) await pullWithRegistryAuth(image, auth);
    const keep = this.opts.keepAlive ?? "infinity";
    // The declared world → docker flags, or a refusal. `allowlist` has no docker equivalent (it needs an
    // egress proxy or a firewalled network we do not run), and the honest answer to "I cannot restrict this
    // to pypi.org" is to refuse the case — not to run it with full internet and report the score as if the
    // restriction had held. Same contract as the os refusal above.
    const worldArgs = dockerWorldArgs(spec, "DockerDriver");
    // Bind-mount args (-v source:target[:ro]) — come before the image.
    const mountArgs = this.mounts.flatMap((m) => ["-v", `${m.source}:${m.target}${m.readOnly ? ":ro" : ""}`]);
    // Ignore the image ENTRYPOINT/CMD + ensure the base directory + keep-alive. Commands run inside via docker exec.
    // host.docker.internal → the docker host gateway (Docker 20.10+), so a case that calls a host-local model gateway
    // (LiteLLM etc.) reaches it portably on Linux too, matching Docker Desktop's built-in alias. Just a hostname alias —
    // harmless if unused. This is the reachability escape hatch for BYO model endpoints from inside an isolated case.
    const { stdout } = await pexecFile(
      "docker",
      [
        "run",
        "-d",
        "--add-host",
        "host.docker.internal:host-gateway",
        ...worldArgs,
        ...mountArgs,
        "--entrypoint",
        "sh",
        image,
        "-c",
        `mkdir -p ${this.base} && exec sleep ${keep}`,
      ],
      { maxBuffer: MAX_BUFFER },
    ).catch((err) => {
      const e = err as { stderr?: string; message?: string };
      throw new InternalError("DRIVER_PROVISION_FAILED", { image }, e.stderr || e.message);
    });
    const cid = stdout.trim();
    // The provisioner is the site that knows which bytes it launched, so it is the site that records them
    // (rule `protocol` L3). Reading this downstream from `spec.image` would re-derive the world from the
    // request, which is the defect this exists to close.
    const provenance = await resolveDockerImageProvenance(image, cid, this.opts.read);
    return new DockerComputeHandle(cid, this.base, this.opts.echo ?? false, provenance);
  }

  // Tear down a container this process holds no handle to (Driver.reap — the durable session reaper after
  // a crash). Same force-remove as dispose(); a container already gone is a no-op, not an error.
  async reap(id: string): Promise<void> {
    await pexecFile("docker", ["rm", "-f", id], { maxBuffer: MAX_BUFFER }).catch(() => undefined);
  }

  // Agent worlds (W1): capture a live container's filesystem as an image and publish it. HOST-side by
  // design — commit and push talk to the daemon, so the push credential never enters the container and can
  // never be baked into the snapshot. `docker commit` briefly pauses the container (a consistent capture);
  // the local tag is removed after the push — the registry holds the bytes, the host must not accumulate a
  // copy per snapshot.
  async snapshot(id: string, ref: string, auth?: RegistryAuth): Promise<void> {
    await pexecFile("docker", ["commit", id, ref], { maxBuffer: MAX_BUFFER }).catch((err) => {
      const e = err as { stderr?: string; message?: string };
      throw new InternalError("DRIVER_SNAPSHOT_FAILED", { compute: id, ref }, e.stderr || e.message);
    });
    try {
      await pushWithRegistryAuth(ref, auth);
    } finally {
      await pexecFile("docker", ["rmi", ref], { maxBuffer: MAX_BUFFER }).catch(() => undefined);
    }
  }
}
