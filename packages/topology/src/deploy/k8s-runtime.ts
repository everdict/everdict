import { lookup as dnsLookup } from "node:dns/promises";
import {
  type BrowserSnapshot,
  type RegistryAuth,
  type ServiceHarnessSpec,
  type TrustZone,
  UpstreamError,
} from "@everdict/contracts";
import { STORE_DEFS, buildSharedStoreManifests, dependencyStores } from "./dependencies.js";
import { browserDeployName, buildBrowserManifests, buildK8sManifests } from "./k8s-topology.js";
import { type Kubectl, type PortForward, kubectlCli } from "./kubectl.js";
import {
  MANAGED_LABEL,
  buildSharedStoreIngressPolicy,
  buildZoneNetworkPolicies,
  resolveEgressCidrs,
} from "./network-policy.js";
import { DEFAULT_POOL_NS, type StorePlan, planTenantStores } from "./store-binding.js";
import type { TargetEnvHandle, TopologyHandle, TopologyRuntime } from "./topology-runtime.js";

export interface K8sTopologyRuntimeOptions {
  kubectl?: Kubectl;
  context?: string; // kubeconfig context (e.g. "kind-everdict")
  runtimeClass?: string; // the cluster's RuntimeClass (e.g. "gvisor") — applied to all pods when set
  namespacePrefix?: string; // zone namespace prefix (default "everdict-")
  storeEnv?: Record<string, string>;
  provisionDependencies?: boolean; // default store isolation when no zone: true→silo (dedicated deploy), false→external
  poolNamespace?: string; // pool shared-store namespace (default "everdict-shared")
  storeSecret?: string; // seed for minting pool tenant passwords (production: KEK/Vault)
  networkPolicies?: boolean; // create/apply NetworkPolicy from zone.network (default true; enforcement needs a policy CNI)
  egressAllowCIDRs?: string[]; // CIDRs allowed egress under deny-egress (model endpoints etc.)
  modelEndpoints?: string[]; // deny-egress: DNS-resolve these hosts/URLs and auto-add them as egress-allow CIDRs (LiteLLM etc.)
  dnsLookup?: (host: string) => Promise<string[]>; // resolver for test injection (default node:dns)
  browserImage?: string;
  imagePullPolicy?: string; // pre-loaded images (kind etc.): "IfNotPresent"
  registryAuth?: RegistryAuth; // workspace image-registry pull credentials — renders a dockerconfigjson Secret + imagePullSecrets
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch; // for endpoint readiness/CDP lookups (test injection)
}

interface WarmEntry {
  handle: TopologyHandle;
  forwards: PortForward[];
  ns: string;
}

// Live K8sTopologyRuntime: apply manifests + wait for rollout + discover endpoints via port-forward.
// Isomorphic to NomadTopologyRuntime — ServiceTopologyBackend only swaps between them (orchestrator-agnostic).
export class K8sTopologyRuntime implements TopologyRuntime {
  readonly id = "k8s";
  private readonly kubectl: Kubectl;
  private readonly fetchImpl: typeof fetch;
  private readonly warm = new Map<string, WarmEntry>();
  // In-progress deploy (single-flight). The manifests use fixed names (everdict-<id>-<svc>), so under case-level
  // parallelism a second ensure while the warm entry is still empty would re-apply the SAME Deployments concurrently
  // and churn the rollout, so the services never stabilize. Concurrent ensures of the same key share the first deploy
  // promise so the manifests are applied once. (Isomorphic to Nomad + the self-hosted DockerTopologyRuntime.)
  private readonly inFlight = new Map<string, Promise<TopologyHandle>>();
  private readonly sharedStoresReady = new Set<string>(); // pool shared-store deploy happens only once per cluster (deploy-once)

  constructor(private readonly opts: K8sTopologyRuntimeOptions = {}) {
    this.kubectl = opts.kubectl ?? kubectlCli({ context: opts.context });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // Per-zone (tenant) namespace — warm-pool separation + isolation boundary.
  private nsFor(zone?: TrustZone): string {
    if (zone?.namespace) return zone.namespace;
    return `${this.opts.namespacePrefix ?? "everdict-"}${zone?.id ?? "default"}`;
  }

  async ensureTopology(spec: ServiceHarnessSpec, zone?: TrustZone): Promise<TopologyHandle> {
    const key = `${spec.id}@${spec.version}@${zone?.id ?? "default"}`;
    const cached = this.warm.get(key);
    if (cached) return cached.handle;
    const inflight = this.inFlight.get(key);
    if (inflight) return inflight; // concurrent ensures join the first deploy — see the inFlight field comment

    // Register the deploy promise so concurrent callers share it; drop it on completion (success/failure) so a failed
    // deploy retries fresh (a broken topology is never cached in warm).
    const p = this.deploy(spec, key, zone).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async deploy(spec: ServiceHarnessSpec, key: string, zone?: TrustZone): Promise<TopologyHandle> {
    const ns = this.nsFor(zone);
    await this.kubectl.ensureNamespace(ns, { [MANAGED_LABEL.key]: MANAGED_LABEL.value });
    const readySec = Math.floor((this.opts.readyTimeoutMs ?? 120_000) / 1000);

    // Network isolation: apply NetworkPolicy from zone.network (same-ns ingress only → cross-tenant block; deny-egress restricts egress).
    if (this.opts.networkPolicies !== false && zone) {
      // deny-egress: DNS-resolve model endpoints (LiteLLM etc.) to auto-add egress-allow CIDRs.
      const lookup =
        this.opts.dnsLookup ?? ((host: string) => dnsLookup(host, { all: true }).then((a) => a.map((x) => x.address)));
      const autoCidrs =
        zone.network === "deny-egress" && this.opts.modelEndpoints?.length
          ? await resolveEgressCidrs(this.opts.modelEndpoints, lookup)
          : [];
      const policies = buildZoneNetworkPolicies({
        namespace: ns,
        network: zone.network,
        poolNamespace: this.opts.poolNamespace ?? DEFAULT_POOL_NS,
        storePorts: dependencyStores(spec).map((s) => s.def.port),
        egressAllowCIDRs: [...(this.opts.egressAllowCIDRs ?? []), ...autoCidrs],
      });
      if (policies.length > 0) await this.kubectl.apply(policies);
    }

    // Decide the store isolation model: with a zone → plan (pool/silo/external), without → provisionDependencies (silo/external).
    const plan: StorePlan = zone
      ? planTenantStores(spec, zone, { poolNamespace: this.opts.poolNamespace, storeSecret: this.opts.storeSecret })
      : { isolation: this.opts.provisionDependencies ? "silo" : "external", serviceEnv: {}, tenants: [] };

    // pool: shared store (once per cluster) → mint per-tenant DB/role/ACL (DDL against the shared store) → scoped creds into the service env.
    if (plan.isolation === "pool") await this.provisionPool(spec, plan, readySec);

    const isSilo = plan.isolation === "silo";
    const storeEnv = plan.isolation === "pool" ? { ...plan.serviceEnv, ...this.opts.storeEnv } : this.opts.storeEnv;
    const manifests = buildK8sManifests(spec, {
      namespace: ns,
      runtimeClass: this.opts.runtimeClass,
      storeEnv,
      imagePullPolicy: this.opts.imagePullPolicy,
      provisionDependencies: isSilo, // only silo deploys a dedicated store into the zone ns (SLICE 39); pool/external do not.
      ...(this.opts.registryAuth ? { registryAuth: this.opts.registryAuth } : {}),
    });
    await this.kubectl.apply(manifests);

    // silo: bring the dedicated store to Ready before the services (they connect on boot). No port-forward needed thanks to in-cluster DNS.
    if (isSilo) {
      for (const { name } of dependencyStores(spec)) await this.kubectl.rolloutStatus(name, ns, readySec);
    }

    const endpoints: Record<string, string> = {};
    const forwards: PortForward[] = [];
    for (const svc of spec.services) {
      if (svc.port === undefined) continue;
      const deploy = `${spec.id}-${svc.name}`;
      await this.kubectl.rolloutStatus(deploy, ns, readySec);
      const pf = await this.kubectl.portForward(`svc/${deploy}`, ns, svc.port);
      forwards.push(pf);
      const url = `http://127.0.0.1:${pf.localPort}`;
      await this.waitForHttp(url);
      endpoints[svc.name] = url;
    }

    const handle: TopologyHandle = { endpoints };
    this.warm.set(key, { handle, forwards, ns });
    return handle;
  }

  // pool: bring up the shared store once, and mint per-tenant logical objects (dedicated DB+role / Redis ACL) on it.
  // Even hostile tenant code only receives its own DB creds, so cross-access is denied by PG auth / Redis ACL.
  private async provisionPool(spec: ServiceHarnessSpec, plan: StorePlan, readySec: number): Promise<void> {
    const poolNs = this.opts.poolNamespace ?? DEFAULT_POOL_NS;
    const stores = plan.tenants.map((t) => t.store);
    await this.ensureSharedStores(stores, poolNs, readySec);

    for (const t of plan.tenants) {
      const sharedApp = `everdict-shared-${t.store}`;
      const pod = await this.kubectl.podFor(`app=${sharedApp}`, poolNs);
      if (t.store === "postgres" && t.postgresSetup) {
        // psql reads commands from stdin (including \gexec). Admin user = POSTGRES_USER (=everdict, superuser).
        await this.kubectl.exec(
          pod,
          poolNs,
          ["psql", "-U", "everdict", "-d", "everdict", "-v", "ON_ERROR_STOP=1"],
          t.postgresSetup,
        );
      } else if (t.store === "redis" && t.redisSetup) {
        for (const cmd of t.redisSetup) await this.kubectl.exec(pod, poolNs, ["redis-cli", ...cmd]);
      } else if (t.store === "minio" && t.minioSetup) {
        // Via mc (root, bundled in the image): create bucket / user / bucket-scoped policy.
        await this.kubectl.exec(pod, poolNs, ["sh", "-c", t.minioSetup]);
      }
    }
  }

  private async ensureSharedStores(stores: string[], poolNs: string, readySec: number): Promise<void> {
    const missing = [...new Set(stores)].filter((s) => STORE_DEFS[s] && !this.sharedStoresReady.has(s));
    if (missing.length === 0) return;
    await this.kubectl.ensureNamespace(poolNs, { [MANAGED_LABEL.key]: MANAGED_LABEL.value });
    await this.kubectl.apply(buildSharedStoreManifests(missing, poolNs, this.opts.imagePullPolicy));
    // Shared-store ns: allow ingress on the store ports only from an everdict-managed namespace (block reach from outside the platform).
    if (this.opts.networkPolicies !== false) {
      const ports = missing.map((s) => STORE_DEFS[s]?.port).filter((p): p is number => p !== undefined);
      await this.kubectl.apply([buildSharedStoreIngressPolicy(poolNs, ports)]);
    }
    for (const s of missing) {
      await this.kubectl.rolloutStatus(`everdict-shared-${s}`, poolNs, readySec);
      // rollout Ready ≠ accepting connections (postgres initdb etc. — no readiness probe). Wait until it actually accepts.
      await this.waitStoreAccepting(s, poolNs);
      this.sharedStoresReady.add(s);
    }
  }

  // Poll until the store actually accepts connections (pg_isready / redis-cli ping). Called before DDL/ACL.
  private async waitStoreAccepting(store: string, poolNs: string): Promise<void> {
    const probe =
      store === "postgres"
        ? ["pg_isready", "-U", "everdict"]
        : store === "redis"
          ? ["redis-cli", "ping"]
          : store === "minio"
            ? ["sh", "-c", "mc alias set local http://localhost:9000 everdict everdictsecret"]
            : undefined;
    if (!probe) return;
    const interval = this.opts.pollIntervalMs ?? 1000;
    const steps = Math.max(1, Math.floor((this.opts.readyTimeoutMs ?? 60_000) / interval));
    for (let i = 0; i < steps; i++) {
      try {
        const pod = await this.kubectl.podFor(`app=everdict-shared-${store}`, poolNs);
        await this.kubectl.exec(pod, poolNs, probe);
        return;
      } catch {
        // not accepting yet → retry
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new UpstreamError("UPSTREAM_ERROR", { store }, "Timed out waiting for the shared store to become ready");
  }

  async provisionBrowserEnv(spec: ServiceHarnessSpec, runId: string, zone?: TrustZone): Promise<TargetEnvHandle> {
    const ns = this.nsFor(zone);
    const name = browserDeployName(runId);
    const manifests = buildBrowserManifests(runId, {
      namespace: ns,
      runtimeClass: this.opts.runtimeClass,
      image: this.opts.browserImage,
      imagePullPolicy: this.opts.imagePullPolicy,
    });
    await this.kubectl.apply(manifests);
    const browserTargets = [`deployment/${name}`, `service/${name}`];
    try {
      await this.kubectl.rolloutStatus(name, ns, Math.floor((this.opts.readyTimeoutMs ?? 120_000) / 1000));
      const pf = await this.kubectl.portForward(`svc/${name}`, ns, 9222);
      return await this.connectBrowser(runId, ns, browserTargets, pf);
    } catch (err) {
      // Clean up only the browser resources (leave the ns alone since the warm topology lives in the same ns).
      await this.kubectl.deleteResources(browserTargets, ns).catch(() => {});
      throw err;
    }
  }

  private async connectBrowser(
    runId: string,
    ns: string,
    browserTargets: string[],
    pf: PortForward,
  ): Promise<TargetEnvHandle> {
    const fetchImpl = this.fetchImpl; // capture locally since `this` changes inside the returned closures
    const cdpHttp = `http://127.0.0.1:${pf.localPort}`;
    await this.waitForHttp(`${cdpHttp}/json/version`);
    let cdpUrl = cdpHttp;
    try {
      const ver = (await (await fetchImpl(`${cdpHttp}/json/version`)).json()) as { webSocketDebuggerUrl?: string };
      if (ver.webSocketDebuggerUrl) cdpUrl = ver.webSocketDebuggerUrl;
    } catch {
      // parse failed → use the HTTP endpoint as cdpUrl
    }
    try {
      await fetchImpl(`${cdpHttp}/json/new?about:blank`, { method: "PUT" });
    } catch {
      // failing to create a blank tab is not fatal
    }
    return {
      wiring: { target_cdp_url: cdpUrl },
      async snapshot(): Promise<BrowserSnapshot> {
        let targets: Array<{ url?: string }> = [];
        try {
          targets = (await (await fetchImpl(`${cdpHttp}/json/list`)).json()) as typeof targets;
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
      dispose: async () => {
        await pf.stop();
        // Remove only the per-case browser — keep the warm topology (same ns). ns deletion is teardown.
        await this.kubectl.deleteResources(browserTargets, ns).catch(() => {});
      },
    };
  }

  async teardown(spec: ServiceHarnessSpec, zone?: TrustZone): Promise<void> {
    const key = `${spec.id}@${spec.version}@${zone?.id ?? "default"}`;
    const entry = this.warm.get(key);
    this.warm.delete(key);
    for (const pf of entry?.forwards ?? []) await pf.stop().catch(() => {});
    await this.kubectl.deleteNamespace(entry?.ns ?? this.nsFor(zone));
  }

  private async waitForHttp(url: string): Promise<void> {
    const deadline = this.opts.readyTimeoutMs ?? 60_000;
    const interval = this.opts.pollIntervalMs ?? 1000;
    const steps = Math.max(1, Math.floor(deadline / interval));
    for (let i = 0; i < steps; i++) {
      try {
        const res = await this.fetchImpl(url);
        if (res.status < 500) return;
      } catch {
        // not up yet → retry
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new UpstreamError("UPSTREAM_ERROR", { url }, "Timed out waiting for the endpoint to become ready");
  }
}
