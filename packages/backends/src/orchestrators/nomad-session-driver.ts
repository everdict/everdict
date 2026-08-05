import { spawn } from "node:child_process";
import {
  type ComputeHandle,
  type ComputeSpec,
  type Driver,
  type ExecOpts,
  type ExecResult,
  InternalError,
  UpstreamError,
  shq,
} from "@everdict/contracts";
import { type TrustZonePolicy, assertHardenedIsolation } from "@everdict/domain";
import { type NomadHttp, fetchHttp } from "./nomad.js";

// A Driver whose compute is a Nomad allocation instead of a local container (agent worlds W4).
//
// The point of the Driver contract is that it says nothing about WHERE the compute lives — `provision` hands
// back something you can `exec` on and must `dispose`. So a long-lived session on a cluster does not need a
// new concept in the placement layer (`Backend` is one-shot `dispatch(CaseJob) → CaseResult`, which a session
// is simply not shaped like); it needs the same Driver contract implemented over the orchestrator. Everything
// the session service already does — worlds, hibernation, git, retention, capacity, the trajectory — then
// works off the control-plane host with no changes at all.
//
// Deliberately NO `snapshot()`: nothing here can reach a container daemon, which is exactly why the
// registry layer-append path exists (docs/architecture/agent-worlds.md §W4). A caller that finds no
// `snapshot` falls back to capturing over this driver's own exec channel.

const JOB_PREFIX = "everdict-session-";
const TASK = "session";
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 2_000;
const DEFAULT_BASE = "/everdict";

export interface NomadSessionDriverOptions {
  addr: string; // Nomad HTTP endpoint
  apiToken?: string; // ACL token (X-Nomad-Token) — control-plane↔cluster auth, never in the alloc env
  namespace?: string; // default namespace; a trust zone's namespace wins per provision
  datacenters?: string[];
  trustZones?: TrustZonePolicy; // per-tenant isolation — resolved per provision from `spec.tenant`
  cpu?: number;
  memoryMb?: number;
  readyTimeoutMs?: number;
  base?: string; // working root inside the task (the same `/everdict` every other lane assumes)
  http?: NomadHttp;
  // Injected so the exec path is testable without a `nomad` binary. Same shape NomadBackend uses.
  execRunner?: (
    bin: string,
    args: string[],
    env: Record<string, string>,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}

function spawnRunner(
  bin: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += String(d);
    });
    proc.stderr.on("data", (d) => {
      stderr += String(d);
    });
    proc.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr + String(e) }));
    proc.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// The compute id encodes everything a LATER process needs to reach or remove this session: the job, its
// namespace, and the alloc to exec into. A session outlives the request that made it (and sometimes the
// process), so the id has to be self-describing — the reaper gets nothing but this string off the run row.
export function sessionComputeId(jobId: string, allocId: string, namespace?: string): string {
  return `${jobId}|${allocId}|${namespace ?? ""}`;
}

export function parseSessionComputeId(id: string): { jobId: string; allocId: string; namespace?: string } {
  const [jobId = "", allocId = "", namespace = ""] = id.split("|");
  return { jobId, allocId, ...(namespace !== "" ? { namespace } : {}) };
}

class NomadSessionHandle implements ComputeHandle {
  readonly id: string;

  constructor(
    private readonly ctx: {
      jobId: string;
      allocId: string;
      namespace?: string;
      base: string;
      http: NomadHttp;
      addr: string;
      apiToken?: string;
      run: NonNullable<NomadSessionDriverOptions["execRunner"]>;
    },
  ) {
    this.id = sessionComputeId(ctx.jobId, ctx.allocId, ctx.namespace);
  }

  private resolve(p: string): string {
    return p.startsWith("/") ? p : `${this.ctx.base}/${p}`;
  }

  async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const cwd = opts?.cwd ? this.resolve(opts.cwd) : this.ctx.base;
    // env goes through the shell rather than `-e` flags: `nomad alloc exec` has no env option, and exporting
    // inside the command keeps a value out of argv (a credential must not land in `ps` on the client node).
    const exports = Object.entries(opts?.env ?? {})
      .map(([k, v]) => `export ${k}=${shq(v)}; `)
      .join("");
    const args = [
      "alloc",
      "exec",
      "-task",
      TASK,
      ...(this.ctx.namespace ? ["-namespace", this.ctx.namespace] : []),
      this.ctx.allocId,
      "sh",
      "-c",
      `mkdir -p ${shq(cwd)}; cd ${shq(cwd)}; ${exports}${cmd}`,
    ];
    const env: Record<string, string> = { NOMAD_ADDR: this.ctx.addr };
    if (this.ctx.apiToken) env.NOMAD_TOKEN = this.ctx.apiToken;
    const r = await this.ctx.run("nomad", args, env);
    // A non-zero exit is a RESULT (the Driver contract); only a failure to reach the cluster is an error.
    if (r.code === 127 && r.stderr.includes("ENOENT"))
      throw new InternalError(
        "COMPUTE_EXEC_FAILED",
        { alloc: this.ctx.allocId },
        "the `nomad` CLI is not available to the control plane — a cluster-placed session execs through it",
      );
    return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
  }

  // Files travel as base64 through the same exec channel — the one encoding every placement agrees on, and
  // the reason this driver needs no extra transport. Large payloads are the caller's concern (the session
  // service bounds its own captures).
  async writeFile(path: string, data: string): Promise<void> {
    const full = this.resolve(path);
    const encoded = Buffer.from(data, "utf8").toString("base64");
    const res = await this.exec(
      `mkdir -p "$(dirname ${shq(full)})" && printf %s ${shq(encoded)} | base64 -d > ${shq(full)}`,
    );
    if (res.exitCode !== 0)
      throw new InternalError("COMPUTE_EXEC_FAILED", { path: full }, res.stderr || "write failed");
  }

  async readFile(path: string): Promise<string> {
    const res = await this.exec(`base64 -w0 ${shq(this.resolve(path))}`);
    if (res.exitCode !== 0) throw new InternalError("COMPUTE_EXEC_FAILED", { path }, res.stderr || "read failed");
    return Buffer.from(res.stdout.trim(), "base64").toString("utf8");
  }

  async dispose(): Promise<void> {
    await purgeJob(this.ctx.http, this.ctx.jobId, this.ctx.namespace);
  }
}

async function purgeJob(http: NomadHttp, jobId: string, namespace?: string): Promise<void> {
  const ns = namespace ? `&namespace=${encodeURIComponent(namespace)}` : "";
  // purge=true: a session's job is not history worth keeping, and a lingering dead job would collide with
  // the next session that reuses the id.
  await http.request("DELETE", `/v1/job/${encodeURIComponent(jobId)}?purge=true${ns}`).catch(() => undefined);
}

export class NomadSessionDriver implements Driver {
  readonly id = "nomad-session";
  private readonly http: NomadHttp;
  private readonly base: string;

  constructor(private readonly opts: NomadSessionDriverOptions) {
    this.http = opts.http ?? fetchHttp(opts.addr, opts.apiToken);
    this.base = opts.base ?? DEFAULT_BASE;
  }

  async provision(spec: ComputeSpec): Promise<ComputeHandle> {
    if (!spec.image) throw new UpstreamError("UPSTREAM_ERROR", {}, "a cluster-placed session needs an image to run");
    const zone = spec.tenant !== undefined ? this.opts.trustZones?.resolve(spec.tenant) : undefined;
    if (zone) assertHardenedIsolation(zone);
    const namespace = zone?.namespace ?? this.opts.namespace;
    const jobId = `${JOB_PREFIX}${Math.random().toString(36).slice(2, 10)}`;
    const body = {
      Job: {
        ID: jobId,
        Type: "service", // held open until dispose — a batch job would end the moment the command did
        ...(namespace ? { Namespace: namespace } : {}),
        Datacenters: this.opts.datacenters ?? ["dc1"],
        TaskGroups: [
          {
            Name: TASK,
            Count: 1,
            // A session that dies must not be silently restarted underneath its handle: the container's
            // filesystem IS the session, and a fresh one would quietly lose the work.
            RestartPolicy: { Attempts: 0, Mode: "fail" },
            Tasks: [
              {
                Name: TASK,
                Driver: "docker",
                Config: {
                  image: spec.image,
                  ...(zone?.isolationRuntime ? { runtime: zone.isolationRuntime } : {}),
                  // The image's own entrypoint is irrelevant — this container is a filesystem to live in.
                  entrypoint: ["sh"],
                  args: ["-c", `mkdir -p ${this.base} && exec sleep infinity`],
                  ...(spec.registryAuths?.[0]
                    ? {
                        auth: [
                          {
                            username: spec.registryAuths[0].username ?? "everdict",
                            password: spec.registryAuths[0].password,
                          },
                        ],
                      }
                    : {}),
                },
                Resources: { CPU: this.opts.cpu ?? 1000, MemoryMB: this.opts.memoryMb ?? 2048 },
              },
            ],
          },
        ],
      },
    };
    const submitted = await this.http.request("POST", "/v1/jobs", body);
    if (submitted.status >= 300)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: submitted.status, job: jobId },
        `the cluster refused the session job: ${submitted.text.slice(0, 300)}`,
      );
    try {
      const allocId = await this.waitForRunningAlloc(jobId, namespace);
      return new NomadSessionHandle({
        jobId,
        allocId,
        ...(namespace ? { namespace } : {}),
        base: this.base,
        http: this.http,
        addr: this.opts.addr,
        ...(this.opts.apiToken ? { apiToken: this.opts.apiToken } : {}),
        run: this.opts.execRunner ?? spawnRunner,
      });
    } catch (err) {
      await purgeJob(this.http, jobId, namespace); // never leave a job the caller has no handle to
      throw err;
    }
  }

  // Tear down a session this process holds no handle to — the durable reaper's path, from the recorded id.
  async reap(id: string): Promise<void> {
    const { jobId, namespace } = parseSessionComputeId(id);
    if (jobId !== "") await purgeJob(this.http, jobId, namespace);
  }

  private async waitForRunningAlloc(jobId: string, namespace?: string): Promise<string> {
    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    const ns = namespace ? `?namespace=${encodeURIComponent(namespace)}` : "";
    let lastStatus = "none";
    while (Date.now() < deadline) {
      const res = await this.http.request("GET", `/v1/job/${encodeURIComponent(jobId)}/allocations${ns}`);
      if (res.status < 300) {
        const allocs = JSON.parse(res.text) as Array<{ ID: string; ClientStatus?: string }>;
        const running = allocs.find((a) => a.ClientStatus === "running");
        if (running) return running.ID;
        const dead = allocs.find((a) => a.ClientStatus === "failed" || a.ClientStatus === "lost");
        if (dead)
          throw new UpstreamError(
            "UPSTREAM_ERROR",
            { job: jobId, alloc: dead.ID, status: dead.ClientStatus },
            `the session's allocation ${dead.ClientStatus} before it started — check the image and the client's resources`,
          );
        lastStatus = allocs[0]?.ClientStatus ?? "pending";
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { job: jobId, lastStatus },
      `the session did not start within ${Math.round((this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS) / 1000)}s (last allocation status: ${lastStatus})`,
    );
  }
}
