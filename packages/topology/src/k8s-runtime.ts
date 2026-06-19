import { type BrowserSnapshot, type ServiceHarnessSpec, type TrustZone, UpstreamError } from "@assay/core";
import { STORE_DEFS, buildSharedStoreManifests, dependencyStores } from "./dependencies.js";
import { browserDeployName, buildBrowserManifests, buildK8sManifests } from "./k8s-topology.js";
import { type Kubectl, type PortForward, kubectlCli } from "./kubectl.js";
import { MANAGED_LABEL, buildSharedStoreIngressPolicy, buildZoneNetworkPolicies } from "./network-policy.js";
import { DEFAULT_POOL_NS, type StorePlan, planTenantStores } from "./store-binding.js";
import type { BrowserEnvHandle, TopologyHandle, TopologyRuntime } from "./topology-runtime.js";

export interface K8sTopologyRuntimeOptions {
  kubectl?: Kubectl;
  context?: string; // kubeconfig context (예: "kind-assay")
  runtimeClass?: string; // 클러스터의 RuntimeClass (예: "gvisor") — 있으면 모든 파드에 적용
  namespacePrefix?: string; // 존 네임스페이스 접두사 (기본 "assay-")
  storeEnv?: Record<string, string>;
  provisionDependencies?: boolean; // zone 없을 때의 기본 스토어 격리: true→silo(전용 배포), false→external
  poolNamespace?: string; // pool 공유 스토어 네임스페이스 (기본 "assay-shared")
  storeSecret?: string; // pool 테넌트 비번 mint 시드 (프로덕션: KEK/Vault)
  networkPolicies?: boolean; // zone.network 로 NetworkPolicy 생성/적용 (기본 true; enforce 엔 정책-CNI 필요)
  egressAllowCIDRs?: string[]; // deny-egress 일 때 외부로 허용할 CIDR (모델 엔드포인트 등)
  browserImage?: string;
  imagePullPolicy?: string; // kind 등 사전 로드 이미지: "IfNotPresent"
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch; // 엔드포인트 readiness/CDP 조회용 (테스트 주입)
}

interface WarmEntry {
  handle: TopologyHandle;
  forwards: PortForward[];
  ns: string;
}

// 라이브 K8sTopologyRuntime: 매니페스트 apply + rollout 대기 + port-forward 로 엔드포인트 발견.
// NomadTopologyRuntime 과 동형 — ServiceTopologyBackend 는 둘을 교체만 한다(오케스트레이터-비종속).
export class K8sTopologyRuntime implements TopologyRuntime {
  readonly id = "k8s";
  private readonly kubectl: Kubectl;
  private readonly fetchImpl: typeof fetch;
  private readonly warm = new Map<string, WarmEntry>();
  private readonly sharedStoresReady = new Set<string>(); // pool 공유 스토어 배포는 클러스터에 1회만(deploy-once)

  constructor(private readonly opts: K8sTopologyRuntimeOptions = {}) {
    this.kubectl = opts.kubectl ?? kubectlCli({ context: opts.context });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // 존(테넌트)별 네임스페이스 — warm 풀 분리 + 격리 경계.
  private nsFor(zone?: TrustZone): string {
    if (zone?.namespace) return zone.namespace;
    return `${this.opts.namespacePrefix ?? "assay-"}${zone?.id ?? "default"}`;
  }

  async ensureTopology(spec: ServiceHarnessSpec, zone?: TrustZone): Promise<TopologyHandle> {
    const key = `${spec.id}@${spec.version}@${zone?.id ?? "default"}`;
    const cached = this.warm.get(key);
    if (cached) return cached.handle;

    const ns = this.nsFor(zone);
    await this.kubectl.ensureNamespace(ns, { [MANAGED_LABEL.key]: MANAGED_LABEL.value });
    const readySec = Math.floor((this.opts.readyTimeoutMs ?? 120_000) / 1000);

    // 네트워크 격리: zone.network 로 NetworkPolicy 적용(같은-ns ingress 만 → cross-tenant 차단; deny-egress 면 egress 제한).
    if (this.opts.networkPolicies !== false && zone) {
      const policies = buildZoneNetworkPolicies({
        namespace: ns,
        network: zone.network,
        poolNamespace: this.opts.poolNamespace ?? DEFAULT_POOL_NS,
        storePorts: dependencyStores(spec).map((s) => s.def.port),
        egressAllowCIDRs: this.opts.egressAllowCIDRs,
      });
      if (policies.length > 0) await this.kubectl.apply(policies);
    }

    // 스토어 격리 모델 결정: zone 이 있으면 plan(pool/silo/external), 없으면 provisionDependencies(silo/external).
    const plan: StorePlan = zone
      ? planTenantStores(spec, zone, { poolNamespace: this.opts.poolNamespace, storeSecret: this.opts.storeSecret })
      : { isolation: this.opts.provisionDependencies ? "silo" : "external", serviceEnv: {}, tenants: [] };

    // pool: 공유 스토어(클러스터 1회) → 테넌트별 DB/role/ACL mint(공유 스토어에 DDL) → scoped creds 를 서비스 env 로.
    if (plan.isolation === "pool") await this.provisionPool(spec, plan, readySec);

    const isSilo = plan.isolation === "silo";
    const storeEnv = plan.isolation === "pool" ? { ...plan.serviceEnv, ...this.opts.storeEnv } : this.opts.storeEnv;
    const manifests = buildK8sManifests(spec, {
      namespace: ns,
      runtimeClass: this.opts.runtimeClass,
      storeEnv,
      imagePullPolicy: this.opts.imagePullPolicy,
      provisionDependencies: isSilo, // silo 만 전용 스토어를 zone ns 에 배포(SLICE 39); pool/external 은 안 함.
    });
    await this.kubectl.apply(manifests);

    // silo: 전용 스토어를 서비스보다 먼저 Ready (서비스가 부팅 시 접속). in-cluster DNS 라 port-forward 불필요.
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

  // pool: 공유 스토어를 한 번 띄우고, 테넌트별 논리객체(전용 DB+role / Redis ACL)를 공유 스토어에 mint.
  // 적대적 테넌트 코드여도 자기 DB creds 만 받으므로 교차 접근은 PG 인증/Redis ACL 에서 거부된다.
  private async provisionPool(spec: ServiceHarnessSpec, plan: StorePlan, readySec: number): Promise<void> {
    const poolNs = this.opts.poolNamespace ?? DEFAULT_POOL_NS;
    const stores = plan.tenants.map((t) => t.store);
    await this.ensureSharedStores(stores, poolNs, readySec);

    for (const t of plan.tenants) {
      const sharedApp = `assay-shared-${t.store}`;
      const pod = await this.kubectl.podFor(`app=${sharedApp}`, poolNs);
      if (t.store === "postgres" && t.postgresSetup) {
        // psql 이 stdin 에서 명령을 읽음(\gexec 포함). 어드민 user = POSTGRES_USER(=assay, superuser).
        await this.kubectl.exec(
          pod,
          poolNs,
          ["psql", "-U", "assay", "-d", "assay", "-v", "ON_ERROR_STOP=1"],
          t.postgresSetup,
        );
      } else if (t.store === "redis" && t.redisSetup) {
        for (const cmd of t.redisSetup) await this.kubectl.exec(pod, poolNs, ["redis-cli", ...cmd]);
      } else if (t.store === "minio" && t.minioSetup) {
        // mc(루트, 이미지 내장)로 버킷/유저/버킷-한정 정책 생성.
        await this.kubectl.exec(pod, poolNs, ["sh", "-c", t.minioSetup]);
      }
    }
  }

  private async ensureSharedStores(stores: string[], poolNs: string, readySec: number): Promise<void> {
    const missing = [...new Set(stores)].filter((s) => STORE_DEFS[s] && !this.sharedStoresReady.has(s));
    if (missing.length === 0) return;
    await this.kubectl.ensureNamespace(poolNs, { [MANAGED_LABEL.key]: MANAGED_LABEL.value });
    await this.kubectl.apply(buildSharedStoreManifests(missing, poolNs, this.opts.imagePullPolicy));
    // 공유 스토어 ns: assay-managed 네임스페이스에서만 스토어 포트로 ingress 허용(플랫폼 외부 도달 차단).
    if (this.opts.networkPolicies !== false) {
      const ports = missing.map((s) => STORE_DEFS[s]?.port).filter((p): p is number => p !== undefined);
      await this.kubectl.apply([buildSharedStoreIngressPolicy(poolNs, ports)]);
    }
    for (const s of missing) {
      await this.kubectl.rolloutStatus(`assay-shared-${s}`, poolNs, readySec);
      // rollout Ready ≠ accepting connections (postgres initdb 등 — readiness probe 없음). 실접속까지 대기.
      await this.waitStoreAccepting(s, poolNs);
      this.sharedStoresReady.add(s);
    }
  }

  // 스토어가 실제 연결을 받을 때까지 폴링(pg_isready / redis-cli ping). DDL/ACL 전에 호출.
  private async waitStoreAccepting(store: string, poolNs: string): Promise<void> {
    const probe =
      store === "postgres"
        ? ["pg_isready", "-U", "assay"]
        : store === "redis"
          ? ["redis-cli", "ping"]
          : store === "minio"
            ? ["sh", "-c", "mc alias set local http://localhost:9000 assay assaysecret"]
            : undefined;
    if (!probe) return;
    const interval = this.opts.pollIntervalMs ?? 1000;
    const steps = Math.max(1, Math.floor((this.opts.readyTimeoutMs ?? 60_000) / interval));
    for (let i = 0; i < steps; i++) {
      try {
        const pod = await this.kubectl.podFor(`app=assay-shared-${store}`, poolNs);
        await this.kubectl.exec(pod, poolNs, probe);
        return;
      } catch {
        // 아직 안 받음 → 재시도
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new UpstreamError("UPSTREAM_ERROR", { store }, "공유 스토어 준비 대기 시간초과");
  }

  async provisionBrowserEnv(spec: ServiceHarnessSpec, runId: string, zone?: TrustZone): Promise<BrowserEnvHandle> {
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
      // 브라우저 리소스만 정리(warm 토폴로지가 같은 ns 에 있으므로 ns 는 건드리지 않는다).
      await this.kubectl.deleteResources(browserTargets, ns).catch(() => {});
      throw err;
    }
  }

  private async connectBrowser(
    runId: string,
    ns: string,
    browserTargets: string[],
    pf: PortForward,
  ): Promise<BrowserEnvHandle> {
    const fetchImpl = this.fetchImpl; // 반환 closure 에서 this 가 바뀌므로 로컬로 캡처
    const cdpHttp = `http://127.0.0.1:${pf.localPort}`;
    await this.waitForHttp(`${cdpHttp}/json/version`);
    let cdpUrl = cdpHttp;
    try {
      const ver = (await (await fetchImpl(`${cdpHttp}/json/version`)).json()) as { webSocketDebuggerUrl?: string };
      if (ver.webSocketDebuggerUrl) cdpUrl = ver.webSocketDebuggerUrl;
    } catch {
      // 파싱 실패 → HTTP 엔드포인트를 cdpUrl 로
    }
    try {
      await fetchImpl(`${cdpHttp}/json/new?about:blank`, { method: "PUT" });
    } catch {
      // 빈 탭 생성 실패는 치명적 아님
    }
    return {
      cdpUrl,
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
        // per-case 브라우저만 제거 — warm 토폴로지(같은 ns)는 유지. ns 삭제는 teardown.
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
        // 아직 안 뜸 → 재시도
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new UpstreamError("UPSTREAM_ERROR", { url }, "엔드포인트 준비 대기 시간초과");
  }
}
