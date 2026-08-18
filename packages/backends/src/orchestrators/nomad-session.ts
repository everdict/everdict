import type { ImageProvenance } from "@everdict/contracts";
import { type ComputeHandle, type ExecOpts, type ExecResult, InternalError, shq } from "@everdict/contracts";
import type { NomadHttp } from "./nomad.js";

// The compute half of a Nomad-placed SESSION — a held-open allocation the control plane drives step by step.
// `NomadBackend` owns the placement (submitting the service job, applying the trust zone, waiting for the
// allocation); this is only the handle that comes back, kept in its own file so the backend's dispatch path
// stays readable.

export const SESSION_JOB_PREFIX = "everdict-session-";
export const SESSION_TASK = "session";
export const SESSION_BASE = "/everdict"; // the working root every other lane already assumes
export const SESSION_READY_TIMEOUT_MS = 120_000;
export const SESSION_POLL_MS = 2_000;

// The compute id encodes everything a LATER process needs to reach or remove this session: the job, its
// namespace, and the allocation to exec into. A session outlives the request that made it (and sometimes the
// process), so the id has to be self-describing — the reaper gets nothing but this string off the run row.
export function sessionComputeId(jobId: string, allocId: string, namespace?: string): string {
  return `${jobId}|${allocId}|${namespace ?? ""}`;
}

export function parseSessionComputeId(id: string): { jobId: string; allocId: string; namespace?: string } {
  const [jobId = "", allocId = "", namespace = ""] = id.split("|");
  return { jobId, allocId, ...(namespace !== "" ? { namespace } : {}) };
}

export interface NomadSessionHandleContext {
  jobId: string;
  allocId: string;
  namespace?: string;
  http: NomadHttp;
  addr: string;
  apiToken?: string;
  run: (
    bin: string,
    args: string[],
    env: Record<string, string>,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  // The world this alloc was placed from, resolved by the placing lane (see NomadSessionHandle.image).
  image: ImageProvenance;
}

export class NomadSessionHandle implements ComputeHandle {
  readonly id: string;
  // WHICH BYTES this alloc runs. The Nomad API reports no resolved image digest for an allocation, so a
  // reference the caller did not already pin cannot be identified from here — and saying so is the point:
  // "this lane cannot report it" is a standing property of the lane, not an absence of an image.
  readonly image: ImageProvenance;

  constructor(private readonly ctx: NomadSessionHandleContext) {
    this.id = sessionComputeId(ctx.jobId, ctx.allocId, ctx.namespace);
    this.image = ctx.image;
  }

  private resolve(p: string): string {
    return p.startsWith("/") ? p : `${SESSION_BASE}/${p}`;
  }

  async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const cwd = opts?.cwd ? this.resolve(opts.cwd) : SESSION_BASE;
    // env goes through the shell rather than flags: `nomad alloc exec` has no env option, and exporting inside
    // the command keeps a value out of argv (a credential must not land in `ps` on the client node).
    const exports = Object.entries(opts?.env ?? {})
      .map(([k, v]) => `export ${k}=${shq(v)}; `)
      .join("");
    const args = [
      "alloc",
      "exec",
      "-task",
      SESSION_TASK,
      ...(this.ctx.namespace ? ["-namespace", this.ctx.namespace] : []),
      this.ctx.allocId,
      "sh",
      "-c",
      `mkdir -p ${shq(cwd)}; cd ${shq(cwd)}; ${exports}${cmd}`,
    ];
    const env: Record<string, string> = { NOMAD_ADDR: this.ctx.addr };
    if (this.ctx.apiToken) env.NOMAD_TOKEN = this.ctx.apiToken;
    const r = await this.ctx.run("nomad", args, env);
    // A non-zero exit is a RESULT (the Driver contract); only failing to reach the cluster is an error.
    if (r.code === 127 && r.stderr.includes("ENOENT"))
      throw new InternalError(
        "COMPUTE_EXEC_FAILED",
        { alloc: this.ctx.allocId },
        "the `nomad` CLI is not available to the control plane — a cluster-placed session execs through it",
      );
    return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
  }

  // Files travel as base64 through the same exec channel — the one encoding every placement agrees on, and
  // the reason this lane needs no extra transport.
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
    const ns = this.ctx.namespace ? `&namespace=${encodeURIComponent(this.ctx.namespace)}` : "";
    await this.ctx.http
      .request("DELETE", `/v1/job/${encodeURIComponent(this.ctx.jobId)}?purge=true${ns}`)
      .catch(() => undefined);
  }
}
