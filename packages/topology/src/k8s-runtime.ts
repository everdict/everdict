import { type BrowserSnapshot, type ServiceHarnessSpec, type TrustZone, UpstreamError } from "@assay/core";
import { browserDeployName, buildBrowserManifests, buildK8sManifests } from "./k8s-topology.js";
import { type Kubectl, type PortForward, kubectlCli } from "./kubectl.js";
import type { BrowserEnvHandle, TopologyHandle, TopologyRuntime } from "./topology-runtime.js";

export interface K8sTopologyRuntimeOptions {
  kubectl?: Kubectl;
  context?: string; // kubeconfig context (예: "kind-assay")
  runtimeClass?: string; // 클러스터의 RuntimeClass (예: "gvisor") — 있으면 모든 파드에 적용
  namespacePrefix?: string; // 존 네임스페이스 접두사 (기본 "assay-")
  storeEnv?: Record<string, string>;
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
    await this.kubectl.ensureNamespace(ns);
    const manifests = buildK8sManifests(spec, {
      namespace: ns,
      runtimeClass: this.opts.runtimeClass,
      storeEnv: this.opts.storeEnv,
      imagePullPolicy: this.opts.imagePullPolicy,
    });
    await this.kubectl.apply(manifests);

    const endpoints: Record<string, string> = {};
    const forwards: PortForward[] = [];
    for (const svc of spec.services) {
      if (svc.port === undefined) continue;
      const deploy = `${spec.id}-${svc.name}`;
      await this.kubectl.rolloutStatus(deploy, ns, Math.floor((this.opts.readyTimeoutMs ?? 120_000) / 1000));
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
