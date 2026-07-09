import { spawn } from "node:child_process";
import { RESULT_SENTINEL } from "@everdict/agent";
import {
  type AgentJob,
  type CaseResult,
  CaseResultSchema,
  OOM_KILLED,
  UpstreamError,
  assertHardenedIsolation,
  imageUsesRegistryHost,
  judgeEnv,
} from "@everdict/core";
import type {
  Backend,
  BackendCapacity,
  Observable,
  ProbeResult,
  Probeable,
  Recoverable,
  Shellable,
} from "./backend.js";
import type { SecretProvider } from "./secrets.js";
import type { TrustZonePolicy } from "./trust-zone.js";

// --- Nomad HTTP abstraction (mockable in tests) ---
export interface NomadHttp {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }>;
}

// The Nomad HTTP client. If apiToken is present, attaches X-Nomad-Token (ACL auth) to every request.
export function fetchHttp(addr: string, apiToken?: string, fetchImpl?: typeof fetch): NomadHttp {
  const base = addr.replace(/\/$/, "");
  const f = fetchImpl ?? fetch;
  return {
    async request(method, path, body) {
      const headers: Record<string, string> = {};
      if (body) headers["content-type"] = "application/json";
      if (apiToken) headers["x-nomad-token"] = apiToken; // control-plane↔Nomad API auth
      const res = await f(`${base}${path}`, {
        method,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, text: await res.text() };
    },
  };
}

export interface NomadBackendOptions {
  addr: string; // Nomad HTTP endpoint, e.g. http://nomad.internal:4646
  image: string; // runner-agent image (in-house registry)
  apiToken?: string; // Nomad ACL token (X-Nomad-Token) — control-plane↔Nomad API auth. Unrelated to the alloc env.
  http?: NomadHttp;
  secretEnv?: Record<string, string>; // auth to inject into the alloc (e.g. CLAUDE_CODE_OAUTH_TOKEN). The default when secrets is absent.
  secrets?: SecretProvider; // per-tenant secret scoping — inject only that tenant's keys per job (no leakage).
  datacenters?: string[];
  runtime?: string; // docker isolation runtime (e.g. "runsc" = gVisor). trustZones takes precedence if present.
  namespace?: string; // default namespace (when there's no tenant zone)
  trustZones?: TrustZonePolicy; // per-tenant isolation policy — enforces runtime/namespace per job.
  cpuMhz?: number;
  memMb?: number;
  pollIntervalMs?: number;
  // Dead-job purge is OPT-IN: purging a job whose alloc a client still tracks nils the alloc's job reference and
  // panics the client's alloc watcher (observed live on a dev-mode agent, with immediate AND 60s-deferred purges).
  // Real deployments size client.gc_max_allocs for eval churn instead (the actionable 404 below names it); enable
  // purge only where the cluster is known to tolerate it.
  purgeDeadJobs?: boolean; // default false
  // Injectable exec runner (test seam) — default shells to the `nomad` CLI (WS exec is CLI-only in practice).
  // (bin, args, opts) → {code, stdout, stderr}. The default passes NOMAD_ADDR/NOMAD_TOKEN via env.
  execRunner?: (
    bin: string,
    args: string[],
    env: Record<string, string>,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  purgeDelayMs?: number; // age before a dead job is purge-swept when enabled (default 60s; 0 = immediate for tests)
  maxPolls?: number;
  // This cluster's concurrent-job cap (for capacity-aware placement). If a function, dynamically reads the value the autoscaler changes.
  maxConcurrent?: number | (() => number);
  // Declared memory envelope (RuntimeSpec.memoryBudgetMb) — the Scheduler caps the sum of in-flight
  // harness-declared memory against it. Absent = slots-only admission.
  memoryBudgetMb?: number;
  // Declared CPU envelope (RuntimeSpec.cpuBudget) — same admission contract, resources.cpu units.
  cpuBudget?: number;
}

// --- Nomad job spec (only the needed parts typed) ---
interface NomadTask {
  Name: string;
  Driver: string;
  // auth = docker registry auth (the JSON API representation of the HCL auth block = an array) — when case.image is a workspace registry.
  Config: { image: string; runtime?: string; auth?: Array<{ username: string; password: string }> };
  Env: Record<string, string>;
  Resources: { CPU: number; MemoryMB: number };
}
export interface NomadJobSpec {
  Job: {
    ID: string;
    Type: string;
    Namespace?: string;
    Datacenters: string[];
    TaskGroups: Array<{
      Name: string;
      Count: number;
      RestartPolicy: { Attempts: number; Mode: string };
      Tasks: NomadTask[];
    }>;
  };
}

export function nomadJobId(job: AgentJob, suffix?: string): string {
  return `everdict-${job.evalCase.id}${suffix ? `-${suffix}` : ""}`;
}

// Per-dispatch uniqueness — two concurrent batches over the same dataset (or a retry of a finished one) would
// otherwise submit the SAME job id: Nomad treats that as a job update, and waitForAlloc's allocs[0] can then read
// the PREVIOUS dead alloc's logs as this case's result. A fresh id per dispatch removes both hazards; the
// capacity probe matches on the `everdict-` prefix, so it still counts these.
function dispatchSuffix(): string {
  return Math.random().toString(36).slice(2, 7);
}

// AgentJob → Nomad batch job spec. The job payload is carried in the EVERDICT_AGENT_JOB(base64) env.
export function buildNomadJob(job: AgentJob, opts: NomadBackendOptions, jobId?: string): NomadJobSpec {
  const env: Record<string, string> = {
    EVERDICT_AGENT_JOB: Buffer.from(JSON.stringify(job)).toString("base64"),
    ...judgeEnv(job.judge), // per-run judge model config (keys via secretEnv). The inline judge grader judges with this model.
    ...opts.secretEnv,
  };
  // Prefer the per-case image (e.g. the official SWE-bench prebuilt = deps+repo bundled), otherwise the default agent image.
  const image = job.evalCase.image ?? opts.image;
  // For a workspace-registry image, docker auth (transient job credentials) — only when the host matches.
  const registryAuth = job.registryAuth;
  const auth =
    registryAuth && imageUsesRegistryHost(image, registryAuth.host)
      ? [{ username: registryAuth.username ?? "everdict", password: registryAuth.password }]
      : undefined;
  return {
    Job: {
      ID: jobId ?? nomadJobId(job),
      Type: "batch",
      Namespace: opts.namespace,
      Datacenters: opts.datacenters ?? ["dc1"],
      TaskGroups: [
        {
          Name: "eval",
          Count: 1,
          RestartPolicy: { Attempts: 0, Mode: "fail" },
          Tasks: [
            {
              Name: "agent",
              Driver: "docker",
              Config: {
                image,
                ...(opts.runtime ? { runtime: opts.runtime } : {}),
                ...(auth ? { auth } : {}),
              },
              Env: env,
              // Harness-declared resources win (heavier harnesses get real bin-packing; starvation reads as infra).
              Resources: {
                CPU:
                  (job.harnessSpec?.kind === "command" ? job.harnessSpec.resources?.cpu : undefined) ??
                  opts.cpuMhz ??
                  1000,
                MemoryMB:
                  (job.harnessSpec?.kind === "command" ? job.harnessSpec.resources?.memoryMb : undefined) ??
                  opts.memMb ??
                  1024,
              },
            },
          ],
        },
      ],
    },
  };
}

// Default exec runner — spawn a local CLI (nomad) with addr/token in env.
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

function parseResult(stdout: string): CaseResult {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  if (idx < 0) throw new UpstreamError("UPSTREAM_ERROR", undefined, "could not find the agent result (sentinel).");
  const line = stdout.slice(idx + RESULT_SENTINEL.length).split("\n")[0] ?? "";
  return CaseResultSchema.parse(JSON.parse(line));
}

// Model B: launch the runner-agent as a Nomad batch alloc, poll for completion, then
// parse the CaseResult from the sentinel in the stdout log.
export class NomadBackend implements Backend, Recoverable, Observable, Shellable, Probeable {
  readonly id = "nomad";
  private readonly http: NomadHttp;

  constructor(private readonly opts: NomadBackendOptions) {
    this.http = opts.http ?? fetchHttp(opts.addr, opts.apiToken);
  }

  // Capacity: total=configured cap, used=count of in-flight everdict jobs observed in the cluster (live probe, all namespaces).
  // If the probe fails, leave used=0 and gate only via the scheduler's in-flight.
  async capacity(): Promise<BackendCapacity> {
    const mc = this.opts.maxConcurrent;
    const total = (typeof mc === "function" ? mc() : mc) ?? 20;
    try {
      const res = await this.http.request("GET", "/v1/jobs?prefix=everdict-&namespace=*");
      if (res.status < 300) {
        const jobs = JSON.parse(res.text) as Array<{ Status?: string }>;
        const used = jobs.filter((j) => j.Status === "running" || j.Status === "pending").length;
        return {
          total,
          used,
          ...(this.opts.memoryBudgetMb !== undefined ? { memoryBudgetMb: this.opts.memoryBudgetMb } : {}),
          ...(this.opts.cpuBudget !== undefined ? { cpuBudget: this.opts.cpuBudget } : {}),
        };
      }
    } catch {
      // probe failed → used 0
    }
    return {
      total,
      used: 0,
      ...(this.opts.memoryBudgetMb !== undefined ? { memoryBudgetMb: this.opts.memoryBudgetMb } : {}),
      ...(this.opts.cpuBudget !== undefined ? { cpuBudget: this.opts.cpuBudget } : {}),
    };
  }

  // Connection test — check reachability + ACL auth via /v1/agent/self without a job (an ACL cluster requires X-Nomad-Token).
  async probe(): Promise<ProbeResult> {
    try {
      const res = await this.http.request("GET", "/v1/agent/self");
      if (res.status < 300) {
        let name: string | undefined;
        try {
          name = (JSON.parse(res.text) as { member?: { Name?: string } }).member?.Name;
        } catch {
          // ignore a body-parse failure — it did reach.
        }
        return { reachable: true, detail: name ? `Nomad agent: ${name}` : "Nomad agent responded" };
      }
      if (res.status === 401 || res.status === 403)
        return { reachable: false, detail: `auth failed (${res.status}) — check the ACL token (authSecret).` };
      return { reachable: false, detail: `Nomad ${res.status}: ${res.text.slice(0, 200)}` };
    } catch (e) {
      return { reachable: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  // Apply/enforce the tenant zone/secrets per job: untrusted requires strong isolation, a dedicated namespace, and inject only that tenant's keys.
  private async effectiveOpts(job: AgentJob): Promise<NomadBackendOptions> {
    const tenant = job.tenant ?? "default";
    const zone = this.opts.trustZones?.resolve(tenant);
    if (zone) assertHardenedIsolation(zone);
    // Secret scoping: if a provider exists, only that tenant's; otherwise the existing secretEnv.
    const secretEnv = this.opts.secrets ? await this.opts.secrets.secretsFor(tenant) : this.opts.secretEnv;
    if (!zone) return { ...this.opts, secretEnv };
    return {
      ...this.opts,
      secretEnv,
      runtime: zone.isolationRuntime,
      namespace: zone.namespace ?? this.opts.namespace,
    };
  }

  async dispatch(job: AgentJob): Promise<CaseResult> {
    const opts = await this.effectiveOpts(job);
    const ns = opts.namespace;
    const jobId = nomadJobId(job, dispatchSuffix()); // unique per dispatch (concurrent same-case batches + no stale-alloc reads)
    const submit = await this.http.request("POST", "/v1/jobs", buildNomadJob(job, opts, jobId));
    if (submit.status >= 300) {
      throw new UpstreamError("UPSTREAM_ERROR", { status: submit.status }, "Nomad job submission failed");
    }
    try {
      const allocId = await this.waitForAlloc(jobId, ns);
      const nsq = ns ? `&namespace=${encodeURIComponent(ns)}` : "";
      const logs = await this.http.request(
        "GET",
        `/v1/client/fs/logs/${allocId}?task=agent&type=stdout&plain=true${nsq}`,
      );
      if (logs.status >= 300)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { status: logs.status, alloc: allocId },
          // 404 here almost always means the CLIENT already garbage-collected the terminal alloc dir — that happens
          // under batch churn once the node exceeds gc_max_allocs (default 50). The purge below keeps steady-state
          // dead jobs near zero; if a burst still outruns collection, raise client.gc_max_allocs on the Nomad client.
          logs.status === 404
            ? "alloc log fetch failed (alloc dir already GC'd — raise the Nomad client's gc_max_allocs for eval churn)"
            : "alloc log fetch failed",
        );
      return parseResult(logs.text);
    } finally {
      // Purge dead jobs after capturing results (parity with K8sBackend's deleteJob-in-finally). Without it, every
      // batch case leaves a dead job+alloc behind; past gc_max_allocs the client instantly GCs each newly terminal
      // alloc, and the NEXT case's log fetch loses the race → the whole batch reads as dispatch failures.
      // DEFERRED, not immediate: purging a job whose alloc just went terminal races the client's alloc watcher
      // (nil-deref panic on a dev-mode single-process agent, observed live). Each dispatch enqueues its own job and
      // sweeps only entries older than purgeDelayMs — steady state stays bounded, fresh allocs are left alone.
      if (this.opts.purgeDeadJobs === true) {
        this.purgeQueue.push({ jobId, ns, at: Date.now() });
        await this.sweepPurge();
      }
    }
  }

  // Adopt an already-dispatched case job (boot recovery): the control plane died after submitting
  // everdict-<caseId>-<suffix> — instead of re-dispatching (double compute), find the NEWEST such job, wait for
  // its alloc like a normal dispatch, and harvest the result from its logs. undefined on any miss (no job, logs
  // gone, no sentinel) — the caller re-dispatches as before. Best-effort by design.
  async adopt(caseId: string): Promise<CaseResult | undefined> {
    try {
      const prefix = `everdict-${caseId}-`;
      const res = await this.http.request("GET", `/v1/jobs?prefix=${encodeURIComponent(prefix)}&namespace=*`);
      if (res.status >= 300) return undefined;
      const jobs = JSON.parse(res.text) as Array<{ ID?: string; Namespace?: string; SubmitTime?: number }>;
      const newest = jobs
        .filter((j) => j.ID?.startsWith(prefix))
        .sort((a, b) => (b.SubmitTime ?? 0) - (a.SubmitTime ?? 0))[0];
      if (!newest?.ID) return undefined;
      const ns = newest.Namespace && newest.Namespace !== "default" ? newest.Namespace : undefined;
      const allocId = await this.waitForAlloc(newest.ID, ns);
      const nsq = ns ? `&namespace=${encodeURIComponent(ns)}` : "";
      const logs = await this.http.request(
        "GET",
        `/v1/client/fs/logs/${allocId}?task=agent&type=stdout&plain=true${nsq}`,
      );
      if (logs.status >= 300) return undefined;
      return parseResult(logs.text);
    } catch {
      return undefined;
    }
  }

  // One-shot exec inside the case's live alloc (web terminal / live-screen capture). Shells to `nomad alloc
  // exec -task agent <alloc> sh -c <command>` (WS exec is CLI-only), addr/token via env. undefined = no live alloc.
  async exec(
    caseId: string,
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number } | undefined> {
    try {
      const prefix = `everdict-${caseId}-`;
      const res = await this.http.request("GET", `/v1/jobs?prefix=${encodeURIComponent(prefix)}&namespace=*`);
      if (res.status >= 300) return undefined;
      const jobs = JSON.parse(res.text) as Array<{ ID?: string; Namespace?: string; SubmitTime?: number }>;
      const newest = jobs
        .filter((j) => j.ID?.startsWith(prefix))
        .sort((a, b) => (b.SubmitTime ?? 0) - (a.SubmitTime ?? 0))[0];
      if (!newest?.ID) return undefined;
      const ns = newest.Namespace && newest.Namespace !== "default" ? newest.Namespace : undefined;
      const nsq = ns ? `?namespace=${encodeURIComponent(ns)}` : "";
      const allocsRes = await this.http.request("GET", `/v1/job/${encodeURIComponent(newest.ID)}/allocations${nsq}`);
      if (allocsRes.status >= 300) return undefined;
      const alloc = (JSON.parse(allocsRes.text) as Array<{ ID: string; ClientStatus?: string }>).find(
        (a) => a.ClientStatus === "running",
      );
      if (!alloc) return undefined; // no RUNNING alloc — nothing to exec into
      const runner = this.opts.execRunner ?? ((bin, args, env) => spawnRunner(bin, args, env));
      const env: Record<string, string> = { NOMAD_ADDR: this.opts.addr };
      if (this.opts.apiToken) env.NOMAD_TOKEN = this.opts.apiToken;
      const args = [
        "alloc",
        "exec",
        "-task",
        "agent",
        ...(ns ? ["-namespace", ns] : []),
        alloc.ID,
        "sh",
        "-c",
        command,
      ];
      const r = await runner("nomad", args, env);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
    } catch {
      return undefined; // best-effort — observability must never fail a run
    }
  }

  // Open an interactive shell inside the case's live alloc (observability ⑥) — `nomad alloc exec -i -task agent
  // <alloc> /bin/sh`. Returns a stream handle the WS terminal route pipes to. undefined = no running alloc.
  async execStream(caseId: string): Promise<
    | {
        write(data: string): void;
        onData(cb: (chunk: string) => void): void;
        onExit(cb: (code: number | null) => void): void;
        close(): void;
      }
    | undefined
  > {
    try {
      const prefix = `everdict-${caseId}-`;
      const res = await this.http.request("GET", `/v1/jobs?prefix=${encodeURIComponent(prefix)}&namespace=*`);
      if (res.status >= 300) return undefined;
      const jobs = JSON.parse(res.text) as Array<{ ID?: string; Namespace?: string; SubmitTime?: number }>;
      const newest = jobs
        .filter((j) => j.ID?.startsWith(prefix))
        .sort((a, b) => (b.SubmitTime ?? 0) - (a.SubmitTime ?? 0))[0];
      if (!newest?.ID) return undefined;
      const ns = newest.Namespace && newest.Namespace !== "default" ? newest.Namespace : undefined;
      const nsq = ns ? `?namespace=${encodeURIComponent(ns)}` : "";
      const allocsRes = await this.http.request("GET", `/v1/job/${encodeURIComponent(newest.ID)}/allocations${nsq}`);
      if (allocsRes.status >= 300) return undefined;
      const alloc = (JSON.parse(allocsRes.text) as Array<{ ID: string; ClientStatus?: string }>).find(
        (a) => a.ClientStatus === "running",
      );
      if (!alloc) return undefined;
      const env: Record<string, string> = { ...process.env, NOMAD_ADDR: this.opts.addr };
      if (this.opts.apiToken) env.NOMAD_TOKEN = this.opts.apiToken;
      const args = ["alloc", "exec", "-i", "-task", "agent", ...(ns ? ["-namespace", ns] : []), alloc.ID, "/bin/sh"];
      const child = spawn("nomad", args, { stdio: ["pipe", "pipe", "pipe"], env });
      return {
        write: (data) => child.stdin.write(data),
        onData: (cb) => {
          child.stdout.on("data", (d: Buffer) => cb(String(d)));
          child.stderr.on("data", (d: Buffer) => cb(String(d)));
        },
        onExit: (cb) => child.on("close", (code) => cb(code)),
        close: () => child.kill("SIGKILL"),
      };
    } catch {
      return undefined;
    }
  }

  // Current stdout of the case's newest job — live-progress tail (no waiting: a job with no alloc yet reads as
  // undefined and the caller polls again). Sentinel payload stripped (it's the machine result, not progress).
  async logs(caseId: string): Promise<string | undefined> {
    try {
      const prefix = `everdict-${caseId}-`;
      const res = await this.http.request("GET", `/v1/jobs?prefix=${encodeURIComponent(prefix)}&namespace=*`);
      if (res.status >= 300) return undefined;
      const jobs = JSON.parse(res.text) as Array<{ ID?: string; Namespace?: string; SubmitTime?: number }>;
      const newest = jobs
        .filter((j) => j.ID?.startsWith(prefix))
        .sort((a, b) => (b.SubmitTime ?? 0) - (a.SubmitTime ?? 0))[0];
      if (!newest?.ID) return undefined;
      const ns = newest.Namespace && newest.Namespace !== "default" ? newest.Namespace : undefined;
      const nsq = ns ? `?namespace=${encodeURIComponent(ns)}` : "";
      const allocsRes = await this.http.request("GET", `/v1/job/${encodeURIComponent(newest.ID)}/allocations${nsq}`);
      if (allocsRes.status >= 300) return undefined;
      const alloc = (JSON.parse(allocsRes.text) as Array<{ ID: string }>)[0];
      if (!alloc) return undefined; // still queued — nothing to tail yet
      const nsq2 = ns ? `&namespace=${encodeURIComponent(ns)}` : "";
      const logs = await this.http.request(
        "GET",
        `/v1/client/fs/logs/${alloc.ID}?task=agent&type=stdout&plain=true${nsq2}`,
      );
      if (logs.status >= 300) return undefined;
      const idx = logs.text.lastIndexOf(RESULT_SENTINEL);
      return idx < 0 ? logs.text : logs.text.slice(0, idx);
    } catch {
      return undefined; // best-effort — observability must never fail a run
    }
  }

  // Force-stop every live job of a case (superseded batch reclaim) — deregister WITHOUT purge (the purge saga:
  // purging a job a client still tracks panics its alloc watcher). Best-effort, never throws.
  async kill(caseId: string): Promise<void> {
    try {
      const prefix = `everdict-${caseId}-`;
      const res = await this.http.request("GET", `/v1/jobs?prefix=${encodeURIComponent(prefix)}&namespace=*`);
      if (res.status >= 300) return;
      const jobs = JSON.parse(res.text) as Array<{ ID?: string; Namespace?: string; Status?: string }>;
      for (const j of jobs) {
        if (!j.ID?.startsWith(prefix) || j.Status === "dead") continue;
        const nsq = j.Namespace && j.Namespace !== "default" ? `?namespace=${encodeURIComponent(j.Namespace)}` : "";
        await this.http.request("DELETE", `/v1/job/${encodeURIComponent(j.ID)}${nsq}`);
      }
    } catch {
      // best-effort
    }
  }

  // Scan the alloc's task events for an OOM kill (docker driver reports "OOM Killed"/oom notifications).
  private async allocWasOomKilled(allocId: string): Promise<boolean> {
    try {
      const res = await this.http.request("GET", `/v1/allocation/${allocId}`);
      if (res.status >= 300) return false;
      const detail = JSON.parse(res.text) as {
        TaskStates?: Record<
          string,
          { Events?: Array<{ Type?: string; DisplayMessage?: string; Details?: Record<string, string> }> }
        >;
      };
      for (const st of Object.values(detail.TaskStates ?? {})) {
        for (const e of st.Events ?? []) {
          const text = `${e.Type ?? ""} ${e.DisplayMessage ?? ""} ${e.Details?.oom_killed ?? ""}`.toLowerCase();
          if (text.includes("oom")) return true;
        }
      }
    } catch {
      /* detection is best-effort — fall through to the generic alloc-failed error */
    }
    return false;
  }

  private readonly purgeQueue: Array<{ jobId: string; ns: string | undefined; at: number }> = [];
  private async sweepPurge(): Promise<void> {
    const cutoff = Date.now() - (this.opts.purgeDelayMs ?? 60_000);
    while (this.purgeQueue.length > 0) {
      const head = this.purgeQueue[0];
      if (head === undefined || head.at > cutoff) break;
      this.purgeQueue.shift();
      const nsq = head.ns ? `?purge=true&namespace=${encodeURIComponent(head.ns)}` : "?purge=true";
      await this.http.request("DELETE", `/v1/job/${head.jobId}${nsq}`).catch(() => {});
    }
  }

  private async waitForAlloc(jobId: string, namespace?: string): Promise<string> {
    const interval = this.opts.pollIntervalMs ?? 2000;
    const maxPolls = this.opts.maxPolls ?? 900;
    const nsq = namespace ? `?namespace=${encodeURIComponent(namespace)}` : "";
    for (let i = 0; i < maxPolls; i++) {
      const res = await this.http.request("GET", `/v1/job/${jobId}/allocations${nsq}`);
      if (res.status < 300) {
        const allocs = JSON.parse(res.text) as Array<{ ID: string; ClientStatus: string }>;
        const alloc = allocs[0];
        if (alloc) {
          if (alloc.ClientStatus === "complete") return alloc.ID;
          if (alloc.ClientStatus === "failed" || alloc.ClientStatus === "lost") {
            // OOM-killed reads as fatal infra (raise the harness resources), never as an agent failure.
            if (await this.allocWasOomKilled(alloc.ID)) {
              throw new UpstreamError(
                "UPSTREAM_ERROR",
                { alloc: alloc.ID, signal: OOM_KILLED },
                "task OOM-killed — raise the harness's resources.memoryMb (infra, not an agent failure)",
              );
            }
            throw new UpstreamError("UPSTREAM_ERROR", { alloc: alloc.ID, status: alloc.ClientStatus }, "alloc failed");
          }
        }
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new UpstreamError("UPSTREAM_ERROR", { jobId }, "timed out waiting for alloc completion");
  }
}
