import { type ServiceHarnessSpec, flattenEnv } from "@assay/core";
import { meshServiceName } from "./consul-intentions.js";
import { dependencyStores } from "./dependencies.js";
import { sanitizeIdent } from "./store-binding.js";

// warm 토폴로지를 Nomad service 잡으로 렌더 (서비스당 task group; docker + runsc 격리).
// 공유 스토어 엔드포인트는 storeEnv(Consul/static)로 주입. per-run wiring 은 front-door API 로 별도.
// port 가 있는 서비스는 그룹 network 에 dynamic port(label "http")를 잡고 docker 로 매핑 → 호스트에서 발견 가능.
interface NomadTopoTask {
  Name: string;
  Driver: string;
  Config: { image: string; runtime?: string; ports?: string[]; args?: string[]; volumes?: string[] };
  Env: Record<string, string>;
  Resources: { CPU: number; MemoryMB: number };
}
interface NomadDynamicPort {
  Label: string;
  To: number;
}
interface NomadNetwork {
  Mode?: string; // Connect 는 "bridge" 필요
  DynamicPorts: NomadDynamicPort[];
}
// Consul Connect: 그룹 service + Envoy sidecar (+ 다른 메시 서비스로의 upstream). 메시가 intentions 로 enforce.
export interface NomadConnectUpstream {
  DestinationName: string;
  LocalBindPort: number;
}
export interface NomadConnectService {
  Name: string; // 메시 서비스명 t-<zone>-<svc>
  PortLabel: string;
  Connect: { SidecarService: { Proxy?: { Upstreams: NomadConnectUpstream[] } } };
}
interface NomadTopoGroup {
  Name: string;
  Count: number;
  Networks?: NomadNetwork[];
  Services?: NomadConnectService[];
  Tasks: NomadTopoTask[];
}
export interface NomadTopologyJobSpec {
  Job: {
    ID: string;
    Type: string;
    Namespace?: string;
    Datacenters: string[];
    TaskGroups: NomadTopoGroup[];
  };
}

export interface NomadTopologyOptions {
  datacenters?: string[];
  runtime?: string; // 격리 런타임 (예: "runsc")
  namespace?: string;
  storeEnv?: Record<string, string>; // 공유 스토어 엔드포인트 등
  zoneId?: string; // trust-zone(테넌트) 식별자 — warm 잡 ID 에 섞어 테넌트 간 공유를 막는다
  provisionDependencies?: boolean; // spec.dependencies[](postgres/redis)도 같은 잡에 task group 으로 배포
  connect?: boolean; // Consul Connect mesh 활성화(bridge + sidecar) → intentions 가 데이터플레인에서 enforce
}

// Connect 그룹 service(sidecar + upstream). 토폴로지 빌더와 라이브 enforce 프루프가 공유하는 빌딩블록.
export function buildConnectService(
  name: string,
  portLabel: string,
  upstreams: NomadConnectUpstream[] = [],
): NomadConnectService {
  return {
    Name: name,
    PortLabel: portLabel,
    Connect: { SidecarService: upstreams.length > 0 ? { Proxy: { Upstreams: upstreams } } : {} },
  };
}

export function topologyJobId(spec: ServiceHarnessSpec, zoneId?: string): string {
  const base = `assay-harness-${spec.id}-${spec.version}`;
  return zoneId ? `${base}-${zoneId}` : base;
}

// 공유 스토어(spec.dependencies[])를 Nomad task group 으로 렌더(타입별 1개). dynamic port "store" 로 노출 →
// 런타임이 호스트 포트를 발견해 서비스 storeEnv 로 와이어링(K8s 는 DNS 라 빌드타임 확정, Nomad 는 런타임 발견).
export function buildDependencyGroups(spec: ServiceHarnessSpec, opts: NomadTopologyOptions = {}): NomadTopoGroup[] {
  return dependencyStores(spec).map(({ name, def }) => {
    const config: NomadTopoTask["Config"] = { image: def.image, ports: ["store"] };
    if (opts.runtime) config.runtime = opts.runtime;
    if (def.args) config.args = def.args;
    return {
      Name: name,
      Count: 1,
      Networks: [{ DynamicPorts: [{ Label: "store", To: def.port }] }],
      Tasks: [
        {
          Name: name,
          Driver: "docker",
          Config: config,
          Env: { ...def.env },
          Resources: { CPU: 1000, MemoryMB: 1024 },
        },
      ],
    };
  });
}

// pool 공유 스토어 잡 — 클러스터에 1개(테넌트 무관). 그룹명 = assay-shared-<store>, dynamic port "store".
// 런타임이 이 잡을 deploy-once 하고 host:port 를 발견 → 테넌트별 scoped creds 의 엔드포인트로 쓴다.
export const SHARED_STORE_JOB_ID = "assay-shared-stores";
export function buildSharedStoreJob(stores: string[], opts: NomadTopologyOptions = {}): NomadTopologyJobSpec {
  const spec = {
    id: "assay-shared",
    dependencies: [...new Set(stores)].map((store) => ({ store, role: "shared", isolateBy: "schema" })),
    services: [],
  } as unknown as ServiceHarnessSpec;
  return {
    Job: {
      ID: SHARED_STORE_JOB_ID,
      Type: "service",
      Namespace: opts.namespace,
      Datacenters: opts.datacenters ?? ["dc1"],
      TaskGroups: buildDependencyGroups(spec, opts),
    },
  };
}

// silo 전용 스토어 잡 — 테넌트(존)마다 별도 스토어 인스턴스(전용). 그룹명 = assay-store-<zone>-<store>.
// 런타임이 이걸 띄우고 host:port 를 발견해 서비스 connEnv 로 와이어링(pool 과 같은 discover-then-inject, DDL 없음).
export function dedicatedStoreJobId(spec: ServiceHarnessSpec, zoneId: string): string {
  return `assay-store-${spec.id}-${sanitizeIdent(zoneId)}`;
}
export function dedicatedStoreGroup(zoneId: string, store: string): string {
  return `assay-store-${sanitizeIdent(zoneId)}-${store}`;
}
export function buildDedicatedStoreJob(
  spec: ServiceHarnessSpec,
  stores: string[],
  zoneId: string,
  opts: NomadTopologyOptions = {},
): NomadTopologyJobSpec {
  const synth = {
    id: `assay-store-${sanitizeIdent(zoneId)}`,
    dependencies: [...new Set(stores)].map((store) => ({ store, role: "dedicated", isolateBy: "schema" })),
    services: [],
  } as unknown as ServiceHarnessSpec;
  return {
    Job: {
      ID: dedicatedStoreJobId(spec, zoneId),
      Type: "service",
      Namespace: opts.namespace,
      Datacenters: opts.datacenters ?? ["dc1"],
      TaskGroups: buildDependencyGroups(synth, opts), // 그룹명 = assay-store-<zone>-<store>
    },
  };
}

export function buildNomadTopologyJob(spec: ServiceHarnessSpec, opts: NomadTopologyOptions = {}): NomadTopologyJobSpec {
  const serviceGroups = spec.services.map((svc) => {
    const config: NomadTopoTask["Config"] = opts.runtime
      ? { image: svc.image, runtime: opts.runtime }
      : { image: svc.image };
    const group: NomadTopoGroup = {
      Name: svc.name,
      Count: svc.replicas,
      Tasks: [
        {
          Name: svc.name,
          Driver: "docker",
          Config: config,
          // 서비스 정적 env(svc.env) 위에 운영 storeEnv 가 이긴다(스토어 cred 권위). storeEnv 엔 런타임이 발견한 스토어 URL 포함.
          Env: { ...flattenEnv(svc.env), ...opts.storeEnv },
          // 서비스 리소스 요청(svc.resources) — 미설정 시 기본 1코어/1GB. cpu 는 1000=1코어(=MHz 매핑).
          Resources: { CPU: svc.resources?.cpu ?? 1000, MemoryMB: svc.resources?.memoryMb ?? 1024 },
        },
      ],
    };
    // 서비스 볼륨(svc.volumes) — docker 드라이버 마운트. 클라이언트에 docker.volumes.enabled 필요(운영 설정).
    if (svc.volumes && svc.volumes.length > 0) config.volumes = svc.volumes;
    // port 가 있으면 dynamic port + docker 매핑 → 호스트에서 엔드포인트 발견 가능.
    if (svc.port !== undefined) {
      group.Networks = [{ DynamicPorts: [{ Label: "http", To: svc.port }] }];
      config.ports = ["http"];
    }
    // Connect mesh: bridge 네트워크 + 메시 service(sidecar). 서비스 needs 중 다른 서비스는 upstream 으로 →
    // intra-토폴로지 통신이 메시를 타고 intentions 로 통제(같은 테넌트 allow). 외부 front-door 는 mesh gateway(별도).
    if (opts.connect && svc.port !== undefined) {
      const serviceNeeds = svc.needs.filter((n) => spec.services.some((s) => s.name === n));
      const upstreams = serviceNeeds.map((n, i) => ({
        DestinationName: meshServiceName(opts.zoneId ?? "default", n),
        LocalBindPort: 7000 + i,
      }));
      group.Networks = [{ Mode: "bridge", DynamicPorts: [{ Label: "http", To: svc.port }] }];
      group.Services = [buildConnectService(meshServiceName(opts.zoneId ?? "default", svc.name), "http", upstreams)];
    }
    return group;
  });
  const depGroups = opts.provisionDependencies ? buildDependencyGroups(spec, opts) : [];
  return {
    Job: {
      ID: topologyJobId(spec, opts.zoneId),
      Type: "service",
      Namespace: opts.namespace,
      Datacenters: opts.datacenters ?? ["dc1"],
      TaskGroups: [...depGroups, ...serviceGroups],
    },
  };
}

// --- per-case 브라우저(타깃 환경 II): 신선한 headful/headless Chromium + CDP. ---
// 실 익스텐션 로드(--load-extension)는 헤드풀 + 익스텐션 이미지가 필요 → Phase 2(사용자 이미지).
export interface BrowserJobOptions {
  datacenters?: string[];
  runtime?: string;
  namespace?: string;
  image?: string;
  cdpPort?: number;
  args?: string[];
}

export function browserJobId(runId: string): string {
  return `assay-browser-${runId}`;
}

export function buildBrowserJob(
  spec: ServiceHarnessSpec,
  runId: string,
  opts: BrowserJobOptions = {},
): NomadTopologyJobSpec {
  const image = opts.image ?? "chromedp/headless-shell:latest";
  const cdpPort = opts.cdpPort ?? 9222;
  // chromedp/headless-shell 은 이미 CDP 를 9222(socat→내부 9223)로 노출한다.
  // 포트/주소를 직접 덮어쓰면 socat 리스너와 충돌 → CDP 가 안 뜬다. allow-origins 만 추가(ws 연결 허용).
  const args = opts.args ?? ["--remote-allow-origins=*"];
  const config: NomadTopoTask["Config"] = { image, ports: ["cdp"], args };
  if (opts.runtime) config.runtime = opts.runtime;
  return {
    Job: {
      ID: browserJobId(runId),
      Type: "service",
      Namespace: opts.namespace,
      Datacenters: opts.datacenters ?? ["dc1"],
      TaskGroups: [
        {
          Name: "browser",
          Count: 1,
          Networks: [{ DynamicPorts: [{ Label: "cdp", To: cdpPort }] }],
          Tasks: [
            {
              Name: "browser",
              Driver: "docker",
              Config: config,
              Env: { ASSAY_RUN_ID: runId, ASSAY_TARGET: spec.target?.engine ?? "chromium" },
              Resources: { CPU: 1000, MemoryMB: 1024 },
            },
          ],
        },
      ],
    },
  };
}

// --- alloc 에서 매핑된 호스트 포트 발견 (순수/결정적). ---
export interface AllocPort {
  Label: string;
  Value: number;
  To?: number;
  HostIP?: string;
}
export interface AllocLike {
  ID?: string;
  ClientStatus?: string;
  TaskGroup?: string;
  AllocatedResources?: { Shared?: { Ports?: AllocPort[] } };
  Resources?: { Networks?: Array<{ IP?: string; DynamicPorts?: AllocPort[]; ReservedPorts?: AllocPort[] }> };
}

export interface ResolvedPort {
  hostIp: string;
  port: number;
}

// AllocatedResources.Shared.Ports(신규) → Resources.Networks(구) 순으로 label 매칭.
export function resolvePort(alloc: AllocLike, label: string): ResolvedPort | undefined {
  const shared = alloc.AllocatedResources?.Shared?.Ports?.find((p) => p.Label === label);
  if (shared)
    return { hostIp: shared.HostIP && shared.HostIP !== "" ? shared.HostIP : "127.0.0.1", port: shared.Value };
  for (const net of alloc.Resources?.Networks ?? []) {
    const dp = [...(net.DynamicPorts ?? []), ...(net.ReservedPorts ?? [])].find((p) => p.Label === label);
    if (dp) return { hostIp: net.IP && net.IP !== "" ? net.IP : "127.0.0.1", port: dp.Value };
  }
  return undefined;
}
