import { spawn } from "node:child_process";
import {
  BadRequestError,
  type BrowserSnapshot,
  type RegistryAuth,
  type ServiceHarnessSpec,
  type ServiceReadiness,
  type StoreReadQuery,
  type TrustZone,
  UpstreamError,
} from "@everdict/contracts";
import {
  type ConsulClient,
  buildSharedStoreIntention,
  buildTenantIntentions,
  meshServiceName,
} from "./consul-intentions.js";
import { STORE_DEFS, type StoreValues, dependencyStores } from "./dependencies.js";
import {
  type AllocLike,
  SERVICE_GROUP_NAME,
  SHARED_STORE_JOB_ID,
  browserJobId,
  buildBrowserJob,
  buildDedicatedStoreJob,
  buildNomadTopologyJob,
  buildSharedStoreJob,
  dedicatedStoreGroup,
  dedicatedStoreJobId,
  needsPerServiceGroups,
  perServiceGroupName,
  resolvePort,
  servicePortLabel,
  topologyJobId,
} from "./nomad-topology.js";
import { endpointUnreachableError } from "./reachability.js";
import { type StorePlan, planTenantStores, resolveStoreIsolation, sanitizeIdent } from "./store-binding.js";
import { type StoreSeedPlan, buildReadExec, buildSeedExec, resolveStoreReadSlice } from "./store-seed.js";
import type { TargetEnvHandle, TopologyHandle, TopologyRuntime } from "./topology-runtime.js";

// Nomad HTTP abstraction (mockable in tests; same shape as NomadHttp in @everdict/backends).
export interface NomadHttp {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }>;
}

// Run a command inside an alloc (for shared-store DDL/ACL). The default impl shells out to `nomad alloc exec` (the counterpart of K8s kubectl exec).
export interface NomadExec {
  exec(
    allocId: string,
    task: string,
    command: string[],
    opts?: { namespace?: string; stdin?: string },
  ): Promise<string>;
}

function nomadCliExec(addr: string, bin = "nomad"): NomadExec {
  return {
    exec(allocId, task, command, opts) {
      return new Promise<string>((resolve, reject) => {
        const args = [
          "alloc",
          "exec",
          ...(opts?.namespace ? ["-namespace", opts.namespace] : []),
          "-task",
          task,
          allocId,
          ...command,
        ];
        const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NOMAD_ADDR: addr } });
        let out = "";
        let err = "";
        proc.stdout.on("data", (d) => {
          out += d.toString();
        });
        proc.stderr.on("data", (d) => {
          err += d.toString();
        });
        proc.on("error", reject);
        proc.on("close", (code) =>
          code === 0
            ? resolve(out)
            : reject(new Error(`nomad alloc exec ${command[0]} failed (${code}): ${err || out}`)),
        );
        if (opts?.stdin !== undefined) proc.stdin.write(opts.stdin);
        proc.stdin.end();
      });
    },
  };
}

function fetchNomadHttp(addr: string): NomadHttp {
  const base = addr.replace(/\/$/, "");
  return {
    async request(method, path, body) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, text: await res.text() };
    },
  };
}

export interface NomadTopologyRuntimeOptions {
  addr: string; // Nomad HTTP endpoint
  http?: NomadHttp;
  exec?: NomadExec; // alloc exec (pool DDL/ACL); default = nomad CLI
  consul?: ConsulClient; // when set, create Consul Connect intentions from zone.network (network isolation)
  datacenters?: string[];
  runtime?: string; // docker isolation runtime (e.g. "runsc" = gVisor)
  namespace?: string;
  storeEnv?: Record<string, string>; // inject shared-store endpoints (postgres/redis/minio)
  poolNamespace?: string; // pool shared-store Nomad namespace (unset = default)
  storeSecret?: string; // seed for minting pool tenant passwords (production: KEK/Vault)
  browserImage?: string;
  pollIntervalMs?: number;
  maxPolls?: number;
  readyTimeoutMs?: number;
  registryAuth?: RegistryAuth; // workspace image-registry pull credentials — the builder renders them as docker auth
}

// Live NomadTopologyRuntime: register the warm service job + discover endpoints + per-case browser (real CDP).
// The orchestrator-agnostic ServiceTopologyBackend drives topologies on Nomad through this.
export class NomadTopologyRuntime implements TopologyRuntime {
  readonly id = "nomad";
  private readonly http: NomadHttp;
  private readonly execImpl: NomadExec;
  private readonly warm = new Map<string, TopologyHandle>(); // key: id@version@zone
  // In-progress deploy (single-flight). The topology job ID is deterministic (everdict-harness-<id>-<version>-<zone>),
  // so under case-level parallelism a second ensure while the warm entry is still empty would re-POST the SAME job →
  // Nomad treats that as a job UPDATE and churns the alloc, so the services never stabilize ("many cases of the same
  // dataset+harness don't all come up at once"). Concurrent ensures of the same key share the first deploy promise so
  // the job is registered exactly once. (The self-hosted DockerTopologyRuntime already does this; keep them isomorphic.)
  private readonly inFlight = new Map<string, Promise<TopologyHandle>>();
  // pool shared store: deployed once per cluster → discover host:port + allocId (used as the endpoint for the tenant's scoped creds).
  private readonly sharedStores = new Map<string, { hostPort: string; allocId: string; task: string }>();

  constructor(private readonly opts: NomadTopologyRuntimeOptions) {
    this.http = opts.http ?? fetchNomadHttp(opts.addr);
    this.execImpl = opts.exec ?? nomadCliExec(opts.addr);
  }

  async ensureTopology(spec: ServiceHarnessSpec, zone?: TrustZone): Promise<TopologyHandle> {
    // Separate the warm pool per tenant (zone) — don't share arbitrary code execution within the same process.
    const key = `${spec.id}@${spec.version}@${zone?.id ?? "default"}`;
    const cached = this.warm.get(key);
    if (cached) return cached; // warm: deployed only once per (version, zone)
    const inflight = this.inFlight.get(key);
    if (inflight) return inflight; // concurrent ensures join the first deploy — see the inFlight field comment

    // Register the deploy promise so concurrent callers share it; drop it on completion (success/failure) so a failed
    // deploy retries fresh (a broken topology is never cached in warm).
    const p = this.deploy(spec, key, zone).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async deploy(spec: ServiceHarnessSpec, key: string, zone?: TrustZone): Promise<TopologyHandle> {
    const ns = zone?.namespace ?? this.opts.namespace;
    // pool: shared store (once per cluster) → mint per-tenant DB/role/ACL (alloc exec) → scoped creds into the service env.
    // (Nomad has no DNS without Consul, so unlike K8s it discovers host:port at runtime and injects it.)
    let storeEnv = this.opts.storeEnv;
    let storeValues: Partial<Record<string, StoreValues>> | undefined;
    if (zone) {
      const isolation = resolveStoreIsolation(zone);
      // pool = shared store + tenant DDL, silo = a dedicated store instance per tenant (both discover host:port then inject), external = storeEnv.
      if (isolation === "pool") {
        const pool = await this.provisionPool(spec, zone);
        storeEnv = { ...pool.env, ...this.opts.storeEnv };
        storeValues = pool.values;
      } else if (isolation === "silo") {
        const silo = await this.provisionSilo(spec, zone);
        storeEnv = { ...silo.env, ...this.opts.storeEnv };
        storeValues = silo.values;
      }
    }

    // Cross-tenant network isolation is the per-(spec,version,zone) job/namespace/netns separation below — a co-located
    // topology is one alloc/netns with no route to another tenant's. Consul intentions (allow same-tenant + deny the
    // rest) stay as the cross-tenant authorization DECISION (defense-in-depth; also governs a Connect-enabled external
    // front-door gateway if operated). They no longer gate inter-service traffic — co-located peers talk over loopback.
    if (zone && this.opts.consul && zone.network !== "open") {
      for (const intent of buildTenantIntentions(spec, zone)) await this.opts.consul.applyIntention(intent);
    }

    const job = buildNomadTopologyJob(spec, {
      datacenters: this.opts.datacenters,
      runtime: zone?.isolationRuntime ?? this.opts.runtime,
      namespace: ns,
      storeEnv,
      ...(storeValues ? { storeValues } : {}),
      zoneId: zone?.id,
      ...(this.opts.registryAuth ? { registryAuth: this.opts.registryAuth } : {}),
    });
    await this.register(job, ns);

    const jobId = topologyJobId(spec, zone?.id);
    const endpoints: Record<string, string> = {};
    const portedServices = spec.services.filter((svc) => svc.port !== undefined);
    // Endpoint discovery differs by deploy shape:
    // - co-located (homogeneous single-instance): ONE group whose one alloc carries EVERY service's port (labeled per
    //   service) — wait once, resolve all by label.
    // - per-service (heterogeneous/scaled): each service is its OWN group/alloc — wait for and resolve each separately
    //   (a Windows-node service's alloc discovers on its own node; peers reach it via the injected discovery address).
    if (needsPerServiceGroups(spec)) {
      for (const svc of portedServices) {
        const alloc = await this.waitForGroupRunning(jobId, perServiceGroupName(svc.name), ns);
        const p = resolvePort(alloc, servicePortLabel(svc.name));
        if (!p) {
          throw new UpstreamError(
            "UPSTREAM_ERROR",
            { service: svc.name },
            "Could not find the service port in the alloc.",
          );
        }
        const url = `http://${p.hostIp}:${p.port}`;
        await this.waitForHttp(url, svc.readiness);
        endpoints[svc.name] = url;
      }
    } else if (portedServices.length > 0) {
      const alloc = await this.waitForGroupRunning(jobId, SERVICE_GROUP_NAME, ns);
      for (const svc of portedServices) {
        const p = resolvePort(alloc, servicePortLabel(svc.name));
        if (!p) {
          throw new UpstreamError(
            "UPSTREAM_ERROR",
            { service: svc.name },
            "Could not find the service port in the alloc.",
          );
        }
        const url = `http://${p.hostIp}:${p.port}`;
        await this.waitForHttp(url, svc.readiness); // use the service's readiness budget if declared, otherwise the runtime default
        endpoints[svc.name] = url;
      }
    }

    const handle: TopologyHandle = { endpoints };
    this.warm.set(key, handle);
    return handle;
  }

  // pool: bring up the shared store once (discover host:port), and mint per-tenant logical objects (dedicated DB+role / Redis ACL) via alloc exec.
  // Even hostile tenant code only receives its own DB creds, so cross-access is denied by PG auth / Redis ACL (same guarantee as K8s pool).
  private async provisionPool(
    spec: ServiceHarnessSpec,
    zone: TrustZone,
  ): Promise<{ env: Record<string, string>; values: Partial<Record<string, StoreValues>> }> {
    const ns = this.opts.poolNamespace;
    const stores = dependencyStores(spec).map((s) => s.store);
    await this.ensureSharedStores(stores);
    const plan: StorePlan = planTenantStores(spec, zone, {
      poolNamespace: this.opts.poolNamespace,
      storeSecret: this.opts.storeSecret,
      storeEndpoint: (store) => this.sharedStores.get(store)?.hostPort ?? "",
    });
    for (const t of plan.tenants) {
      const rec = this.sharedStores.get(t.store);
      if (!rec) continue;
      if (t.store === "postgres" && t.postgresSetup) {
        await this.execImpl.exec(
          rec.allocId,
          rec.task,
          ["psql", "-U", "everdict", "-d", "everdict", "-v", "ON_ERROR_STOP=1"],
          {
            namespace: ns,
            stdin: t.postgresSetup,
          },
        );
      } else if (t.store === "redis" && t.redisSetup) {
        for (const cmd of t.redisSetup)
          await this.execImpl.exec(rec.allocId, rec.task, ["redis-cli", ...cmd], { namespace: ns });
      } else if (t.store === "minio" && t.minioSetup) {
        await this.execImpl.exec(rec.allocId, rec.task, ["sh", "-c", t.minioSetup], { namespace: ns });
      }
    }
    return { env: plan.serviceEnv, values: plan.storeValues };
  }

  // silo: bring up the tenant's dedicated store job, discover host:port, and inject it into the service connEnv (no DDL — the whole instance belongs to the tenant).
  private async provisionSilo(
    spec: ServiceHarnessSpec,
    zone: TrustZone,
  ): Promise<{ env: Record<string, string>; values: Partial<Record<string, StoreValues>> }> {
    const ns = zone.namespace ?? this.opts.namespace;
    const stores = [...new Set(dependencyStores(spec).map((s) => s.store))];
    if (stores.length === 0) return { env: {}, values: {} };
    await this.register(
      buildDedicatedStoreJob(spec, stores, zone.id, { datacenters: this.opts.datacenters, namespace: ns }),
      ns,
    );
    const env: Record<string, string> = {};
    const values: Partial<Record<string, StoreValues>> = {};
    for (const store of stores) {
      const alloc = await this.waitForGroupRunning(
        dedicatedStoreJobId(spec, zone.id),
        dedicatedStoreGroup(zone.id, store),
        ns,
      );
      const p = resolvePort(alloc, "store");
      if (!p)
        throw new UpstreamError("UPSTREAM_ERROR", { store }, "Could not find the dedicated store port in the alloc.");
      const def = STORE_DEFS[store];
      if (!def) continue;
      const v = def.values(`${p.hostIp}:${p.port}`);
      values[store] = v;
      Object.assign(env, def.connEnv(v));
    }
    return { env, values };
  }

  private async ensureSharedStores(stores: string[]): Promise<void> {
    const ns = this.opts.poolNamespace;
    const missing = [...new Set(stores)].filter((s) => STORE_DEFS[s] && !this.sharedStores.has(s));
    if (missing.length === 0) return;
    await this.register(buildSharedStoreJob(missing, { datacenters: this.opts.datacenters, namespace: ns }), ns);
    for (const s of missing) {
      const task = `everdict-shared-${s}`;
      const alloc = await this.waitForGroupRunning(SHARED_STORE_JOB_ID, task, ns);
      const p = resolvePort(alloc, "store");
      if (!p || !alloc.ID) {
        throw new UpstreamError("UPSTREAM_ERROR", { store: s }, "Could not find the shared store port in the alloc.");
      }
      const rec = { hostPort: `${p.hostIp}:${p.port}`, allocId: alloc.ID, task };
      await this.waitStoreAccepting(s, rec);
      this.sharedStores.set(s, rec);
      // Shared-store intention: only mesh services can reach it (tenant isolation = DB creds). Enforcement needs a Connect-enabled job.
      if (this.opts.consul) await this.opts.consul.applyIntention(buildSharedStoreIntention(s));
    }
  }

  // Poll until the store actually accepts connections (rollout running ≠ accepting; postgres initdb etc.). Called before DDL.
  private async waitStoreAccepting(store: string, rec: { allocId: string; task: string }): Promise<void> {
    const probe =
      store === "postgres"
        ? ["pg_isready", "-U", "everdict"]
        : store === "redis"
          ? ["redis-cli", "ping"]
          : store === "minio"
            ? ["sh", "-c", "mc alias set local http://localhost:9000 everdict everdictsecret"]
            : undefined;
    if (!probe) return;
    const interval = this.opts.pollIntervalMs ?? 2000;
    const steps = this.opts.maxPolls ?? 60;
    for (let i = 0; i < steps; i++) {
      try {
        await this.execImpl.exec(rec.allocId, rec.task, probe, { namespace: this.opts.poolNamespace });
        return;
      } catch {
        // not accepting yet → retry
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new UpstreamError("UPSTREAM_ERROR", { store }, "Timed out waiting for the shared store to become ready");
  }

  // Resolve WHERE a store's per-case slice lives + which alloc/task to exec in — the same decision the deploy made.
  // silo = the zone's dedicated store job (group == task), default `everdict` DB. pool = the cluster-shared store's
  // running alloc (from the deploy's sharedStores map) + the tenant's `tenant_<slug>` DB. Both need a zone; external
  // (BYO) is rejected loud. Nomad has no store without a zone (no-zone deploys no dependency stores).
  private async storeAllocTarget(
    spec: ServiceHarnessSpec,
    store: string,
    zone: TrustZone | undefined,
    op: string,
  ): Promise<{ allocId: string; task: string; ns: string | undefined; db: string }> {
    if (!zone) {
      throw new BadRequestError("BAD_REQUEST", { op }, `store ${op} on Nomad needs a tenant zone.`);
    }
    const isolation = resolveStoreIsolation(zone);
    if (isolation === "silo") {
      const ns = zone.namespace ?? this.opts.namespace;
      const group = dedicatedStoreGroup(zone.id, store); // group == task name for a dedicated store
      const alloc = await this.waitForGroupRunning(dedicatedStoreJobId(spec, zone.id), group, ns);
      if (!alloc.ID) {
        throw new UpstreamError("UPSTREAM_ERROR", { store, op }, "Could not resolve the dedicated store alloc.");
      }
      return { allocId: alloc.ID, task: group, ns, db: "everdict" };
    }
    if (isolation === "pool") {
      const rec = this.sharedStores.get(store);
      if (!rec) {
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { store, op },
          "Shared store not provisioned — ensure the topology first.",
        );
      }
      return {
        allocId: rec.allocId,
        task: rec.task,
        ns: this.opts.poolNamespace,
        db: `tenant_${sanitizeIdent(zone.id)}`,
      };
    }
    throw new BadRequestError(
      "BAD_REQUEST",
      { op },
      `store ${op} on Nomad does not support external (BYO) stores — Everdict cannot exec into one it doesn't run.`,
    );
  }

  // Fixture seeding (P2): apply each plan inside the store's alloc via `nomad alloc exec` (buildSeedExec).
  async seedFixtures(
    spec: ServiceHarnessSpec,
    _runId: string,
    plans: StoreSeedPlan[],
    zone?: TrustZone,
  ): Promise<void> {
    for (const plan of plans) {
      const t = await this.storeAllocTarget(spec, plan.store, zone, "seeding");
      for (const argv of buildSeedExec(plan, t.db).argvs) {
        await this.execImpl.exec(t.allocId, t.task, argv, { namespace: t.ns });
      }
    }
  }

  // Store-state grading read (P2): resolve the store's per-case slice and run the query in the alloc, returning stdout.
  async readStoreState(
    spec: ServiceHarnessSpec,
    runId: string,
    query: StoreReadQuery,
    zone?: TrustZone,
  ): Promise<string> {
    const t = await this.storeAllocTarget(spec, query.store, zone, "reading");
    const slice = resolveStoreReadSlice(spec.dependencies, query.store, query.role, runId);
    return await this.execImpl.exec(t.allocId, t.task, buildReadExec(query.store, slice, query.query, t.db), {
      namespace: t.ns,
    });
  }

  async provisionBrowserEnv(spec: ServiceHarnessSpec, runId: string, zone?: TrustZone): Promise<TargetEnvHandle> {
    const ns = zone?.namespace ?? this.opts.namespace;
    const job = buildBrowserJob(spec, runId, {
      datacenters: this.opts.datacenters,
      runtime: zone?.isolationRuntime ?? this.opts.runtime,
      namespace: ns,
      image: this.opts.browserImage,
    });
    await this.register(job, ns);
    // Any failure after register would leak the alloc (handle not returned → cannot dispose), so clean up immediately.
    try {
      return await this.connectBrowser(runId, ns);
    } catch (err) {
      await this.deregister(browserJobId(runId), ns);
      throw err;
    }
  }

  // Rediscover a running browser alloc's CDP HTTP base by runId (observability ⑦) — one poll, no provisioning,
  // undefined on any miss (no alloc / not running / no cdp port). The control plane captures a live frame from it.
  async browserCdpBase(runId: string, zone?: TrustZone): Promise<string | undefined> {
    try {
      const ns = zone?.namespace ?? this.opts.namespace;
      const res = await this.http.request("GET", `/v1/job/${browserJobId(runId)}/allocations${this.nsq(ns, "?")}`);
      if (res.status >= 300) return undefined;
      const running = (JSON.parse(res.text) as AllocLike[]).find(
        (a) => a.TaskGroup === "browser" && a.ClientStatus === "running",
      );
      if (!running?.ID) return undefined;
      const full = await this.http.request("GET", `/v1/allocation/${running.ID}${this.nsq(ns, "?")}`);
      if (full.status >= 300) return undefined;
      const p = resolvePort(JSON.parse(full.text) as AllocLike, "cdp");
      return p ? `http://${p.hostIp}:${p.port}` : undefined;
    } catch {
      return undefined;
    }
  }

  private async connectBrowser(runId: string, ns?: string): Promise<TargetEnvHandle> {
    const alloc = await this.waitForGroupRunning(browserJobId(runId), "browser", ns);
    const p = resolvePort(alloc, "cdp");
    if (!p) {
      throw new UpstreamError("UPSTREAM_ERROR", { runId }, "Could not find the browser CDP port in the alloc.");
    }
    const cdpHttp = `http://${p.hostIp}:${p.port}`;
    await this.waitForHttp(`${cdpHttp}/json/version`);

    let cdpUrl = cdpHttp;
    try {
      const ver = (await (await fetch(`${cdpHttp}/json/version`)).json()) as { webSocketDebuggerUrl?: string };
      if (ver.webSocketDebuggerUrl) cdpUrl = ver.webSocketDebuggerUrl;
    } catch {
      // if /json/version parsing fails, use the HTTP endpoint as cdpUrl (for live debugging).
    }
    // Fresh session: open a single blank tab (the real harness/extension navigates from here later). best-effort.
    try {
      await fetch(`${cdpHttp}/json/new?about:blank`, { method: "PUT" });
    } catch {
      // failing to create a tab is not fatal — the snapshot just observes an empty target list.
    }

    const deregister = () => this.deregister(browserJobId(runId), ns);
    return {
      wiring: { target_cdp_url: cdpUrl },
      async snapshot(): Promise<BrowserSnapshot> {
        // Real browser observation: the open target list (current URLs). Extension-driven navigation is Phase 2.
        let targets: Array<{ url?: string; title?: string }> = [];
        try {
          targets = (await (await fetch(`${cdpHttp}/json/list`)).json()) as typeof targets;
        } catch {
          targets = [];
        }
        return {
          kind: "browser",
          url: targets[0]?.url ?? "about:blank",
          dom: JSON.stringify(targets),
          screenshotRef: `runs/${runId}/screenshot.png`,
          console: [],
        };
      },
      async dispose(): Promise<void> {
        await deregister();
      },
    };
  }

  // Tear down the warm topology (for teardown after a live run). Given a zone, tear down only that zone's warm entry.
  async teardown(spec: ServiceHarnessSpec, zone?: TrustZone): Promise<void> {
    this.warm.delete(`${spec.id}@${spec.version}@${zone?.id ?? "default"}`);
    if (zone && this.opts.consul) {
      for (const svc of spec.services) {
        await this.opts.consul.deleteIntention(meshServiceName(zone.id, svc.name)).catch(() => {});
      }
    }
    const ns = zone?.namespace ?? this.opts.namespace;
    // Also clean up the silo dedicated-store job (if there's a zone; otherwise a no-op).
    if (zone) await this.deregister(dedicatedStoreJobId(spec, zone.id), ns);
    await this.deregister(topologyJobId(spec, zone?.id), ns);
  }

  private nsq(namespace: string | undefined, sep: "?" | "&"): string {
    return namespace ? `${sep}namespace=${encodeURIComponent(namespace)}` : "";
  }

  private async register(job: { Job: { ID: string } }, namespace?: string): Promise<void> {
    const res = await this.http.request("POST", `/v1/jobs${this.nsq(namespace, "?")}`, job);
    if (res.status >= 300) {
      throw new UpstreamError("UPSTREAM_ERROR", { status: res.status, job: job.Job.ID }, "Nomad job submission failed");
    }
  }

  private async deregister(jobId: string, namespace?: string): Promise<void> {
    await this.http.request("DELETE", `/v1/job/${jobId}?purge=true${this.nsq(namespace, "&")}`);
  }

  // Poll until the group's alloc is running, then return the full alloc (including ports).
  private async waitForGroupRunning(jobId: string, group: string, namespace?: string): Promise<AllocLike> {
    const interval = this.opts.pollIntervalMs ?? 2000;
    const maxPolls = this.opts.maxPolls ?? 150;
    for (let i = 0; i < maxPolls; i++) {
      const res = await this.http.request("GET", `/v1/job/${jobId}/allocations${this.nsq(namespace, "?")}`);
      if (res.status < 300) {
        const allocs = JSON.parse(res.text) as AllocLike[];
        const mine = allocs.filter((a) => a.TaskGroup === group);
        const failed = mine.find((a) => a.ClientStatus === "failed" || a.ClientStatus === "lost");
        if (failed) {
          throw new UpstreamError("UPSTREAM_ERROR", { group, status: failed.ClientStatus }, "Topology alloc failed");
        }
        const running = mine.find((a) => a.ClientStatus === "running");
        if (running?.ID) {
          const full = await this.http.request("GET", `/v1/allocation/${running.ID}${this.nsq(namespace, "?")}`);
          if (full.status < 300) return JSON.parse(full.text) as AllocLike;
        }
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { jobId, group },
      "Timed out waiting for the topology alloc to become running",
    );
  }

  // Poll until the endpoint returns an HTTP response (5xx / connection refused are retried).
  private async waitForHttp(url: string, readiness?: ServiceReadiness): Promise<void> {
    // Use the service's readiness timeout/interval if declared, otherwise the runtime default (isomorphic to the docker runtime).
    const deadline = readiness?.timeoutMs ?? this.opts.readyTimeoutMs ?? 60_000;
    const interval = readiness?.intervalMs ?? this.opts.pollIntervalMs ?? 2000;
    const steps = Math.max(1, Math.floor(deadline / interval));
    for (let i = 0; i < steps; i++) {
      try {
        const res = await fetch(url);
        if (res.status < 500) return;
      } catch {
        // not up yet → retry
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw endpointUnreachableError(url);
  }
}
