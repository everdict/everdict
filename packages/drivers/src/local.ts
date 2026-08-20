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
  NO_IMAGE,
  type ProvisionedWorldProof,
  isDefaultNetwork,
  isEmptyResourceRequest,
  worldProofCovers,
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

  // A host process comes out of no image. This is a POSITIVE claim, not a shrug: two runs that both
  // provisioned nothing ran in the same world, which is a different statement from two runs whose images
  // nobody could identify.
  readonly image = NO_IMAGE;

  constructor(
    private readonly root: string,
    private readonly echo: boolean = false,
    // Did THIS handle create the root? A handle given a root it did not make must never remove it — the
    // verifier lane runs rooted at the container's own filesystem (`/`), and a dispose that recursed from
    // there would delete the container. Ownership is a fact about how the handle was built, so it is a
    // parameter rather than something dispose() tries to infer from the path.
    private readonly ownsRoot: boolean = true,
    // How long a detached grandchild gets to flush after the parent exited (`DEFAULT_EXIT_GRACE_MS` when
    // unset) — see `RunSpawnOptions.exitGraceMs`.
    private readonly exitGraceMs?: number,
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
          ...(this.exitGraceMs !== undefined ? { exitGraceMs: this.exitGraceMs } : {}),
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
      ...(this.exitGraceMs !== undefined ? { exitGraceMs: this.exitGraceMs } : {}),
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
    if (this.ownsRoot) await rm(this.root, { recursive: true, force: true });
  }
}

export interface LocalDriverOptions {
  // TEE every exec's output to this process's stdio (in-job: the job log becomes a live progress feed).
  echo?: boolean;
  // How long a detached grandchild gets to flush after the parent exited — `DEFAULT_EXIT_GRACE_MS` unless a
  // caller says otherwise. Injectable because it is a policy, and because the case that proves late output
  // is captured has to lose the race deliberately rather than by out-waiting the OS scheduler (see
  // `RunSpawnOptions.exitGraceMs`).
  exitGraceMs?: number;
  // ── THE FILE API AND THE SHELL MUST SHARE ONE NAMESPACE (arch-review 57 P0) ──────────────────────
  //
  // `writeFile(p)` is `join(root, p)`, so with the default temp root an absolute path is REWRITTEN:
  // `/tests/test.sh` becomes `<tmp>/tests/test.sh`, while `bash /tests/test.sh` in a shell command means the
  // real one. For an agent sandbox that is exactly right — the temp directory IS the world, and paths are
  // relative to it. For a container task it is not: the format's `/app`, `/tests` and `/logs/verifier` are
  // absolute paths in an image that already exists, and a verifier that wrote its hidden tests to a temp
  // directory then ran the image's copy would grade a world it had not set up.
  //
  // So a lane whose world is the container itself passes `root: "/"`, and with it `ownsRoot: false` — the
  // handle did not create that directory and must not remove it. Absent: a fresh temp directory, owned.
  root?: string;
  // What the OUTER layer enforced about this container, if anything (arch-review 57 P1-high). A host process
  // can enforce no cpu ceiling and no egress rule, so a declared world is refused here — unless the backend
  // that built the box states it applied that exact declaration. Absent on a bare host run, which is why
  // `everdict run` still refuses a case that declares a world it cannot provide.
  worldProof?: ProvisionedWorldProof;
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
    // …and the same rule, third axis: a host process is not a box with a size or a network of its own.
    // LocalDriver runs the harness as a child process in the operator's own namespace, so it can enforce
    // neither a cpu/memory ceiling nor an egress restriction. Accepting the declaration and ignoring it is
    // the failure this whole field exists to prevent — the case would run unlimited and online, and its
    // score would be filed as the answer to a question about a 2 GB offline box.
    // ── UNLESS THE LAYER THAT MADE THE BOX SAYS IT ENFORCED IT (arch-review 57 P1-high) ─────────────
    //
    // On a managed lane this driver runs INSIDE a container the backend built, and that backend is the only
    // layer that could have applied the declaration. Before the proof existed there was no way to say so, so
    // a declared world reached here and was refused — after the container was already up. A case declaring
    // cpu/memory could not run managed at all, and the container-task corpora declare one routinely.
    //
    // The proof is checked, not trusted: `worldProofCovers` requires the SAME declaration on every axis the
    // case asked about. A proof silent on one axis does not cover it, which keeps partial enforcement from
    // reading as enforcement — and with no proof at all the refusals below stand exactly as they were.
    const covered = worldProofCovers(this.opts.worldProof, spec.resources, spec.network);
    if (!covered && !isEmptyResourceRequest(spec.resources)) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { resources: spec.resources },
        "LocalDriver runs the harness as a host process and cannot enforce a cpu/memory/gpu limit, but the case declared one. " +
          "Route it to a container runtime (DockerDriver / a registered nomad·k8s runtime), or drop the declaration.",
      );
    }
    if (!covered && !isDefaultNetwork(spec.network)) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { network: spec.network?.mode },
        "LocalDriver shares the host network and cannot enforce a network policy, but the case declared one. " +
          "Route it to a container runtime — running an offline-declared case with host network access would measure a different task.",
      );
    }
    const given = this.opts.root;
    const root = given ?? (await mkdtemp(join(tmpdir(), "everdict-")));
    return new LocalComputeHandle(root, this.opts.echo ?? false, given === undefined, this.opts.exitGraceMs);
  }
}
