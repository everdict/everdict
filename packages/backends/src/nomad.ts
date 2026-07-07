import { RESULT_SENTINEL } from "@everdict/agent";
import {
  type AgentJob,
  type CaseResult,
  CaseResultSchema,
  UpstreamError,
  assertHardenedIsolation,
  imageUsesRegistryHost,
  judgeEnv,
} from "@everdict/core";
import type { Backend, BackendCapacity, ProbeResult } from "./backend.js";
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
  maxPolls?: number;
  // This cluster's concurrent-job cap (for capacity-aware placement). If a function, dynamically reads the value the autoscaler changes.
  maxConcurrent?: number | (() => number);
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

export function nomadJobId(job: AgentJob): string {
  return `everdict-${job.evalCase.id}`;
}

// AgentJob → Nomad batch job spec. The job payload is carried in the EVERDICT_AGENT_JOB(base64) env.
export function buildNomadJob(job: AgentJob, opts: NomadBackendOptions): NomadJobSpec {
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
      ID: nomadJobId(job),
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
              Resources: { CPU: opts.cpuMhz ?? 1000, MemoryMB: opts.memMb ?? 1024 },
            },
          ],
        },
      ],
    },
  };
}

function parseResult(stdout: string): CaseResult {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  if (idx < 0) throw new UpstreamError("UPSTREAM_ERROR", undefined, "could not find the agent result (sentinel).");
  const line = stdout.slice(idx + RESULT_SENTINEL.length).split("\n")[0] ?? "";
  return CaseResultSchema.parse(JSON.parse(line));
}

// Model B: launch the runner-agent as a Nomad batch alloc, poll for completion, then
// parse the CaseResult from the sentinel in the stdout log.
export class NomadBackend implements Backend {
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
        return { total, used };
      }
    } catch {
      // probe failed → used 0
    }
    return { total, used: 0 };
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
    const submit = await this.http.request("POST", "/v1/jobs", buildNomadJob(job, opts));
    if (submit.status >= 300) {
      throw new UpstreamError("UPSTREAM_ERROR", { status: submit.status }, "Nomad job submission failed");
    }
    const allocId = await this.waitForAlloc(nomadJobId(job), ns);
    const nsq = ns ? `&namespace=${encodeURIComponent(ns)}` : "";
    const logs = await this.http.request(
      "GET",
      `/v1/client/fs/logs/${allocId}?task=agent&type=stdout&plain=true${nsq}`,
    );
    if (logs.status >= 300)
      throw new UpstreamError("UPSTREAM_ERROR", { status: logs.status }, "alloc log fetch failed");
    return parseResult(logs.text);
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
            throw new UpstreamError("UPSTREAM_ERROR", { alloc: alloc.ID, status: alloc.ClientStatus }, "alloc failed");
          }
        }
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new UpstreamError("UPSTREAM_ERROR", { jobId }, "timed out waiting for alloc completion");
  }
}
