import type { ServiceHarnessSpec } from "@assay/core";

// warm 토폴로지를 Nomad service 잡으로 렌더 (서비스당 task group; docker + runsc 격리).
// 공유 스토어 엔드포인트는 storeEnv(Consul/static)로 주입. per-run wiring 은 front-door API 로 별도.
// port 가 있는 서비스는 그룹 network 에 dynamic port(label "http")를 잡고 docker 로 매핑 → 호스트에서 발견 가능.
interface NomadTopoTask {
  Name: string;
  Driver: string;
  Config: { image: string; runtime?: string; ports?: string[]; args?: string[] };
  Env: Record<string, string>;
  Resources: { CPU: number; MemoryMB: number };
}
interface NomadDynamicPort {
  Label: string;
  To: number;
}
interface NomadNetwork {
  DynamicPorts: NomadDynamicPort[];
}
interface NomadTopoGroup {
  Name: string;
  Count: number;
  Networks?: NomadNetwork[];
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
}

export function topologyJobId(spec: ServiceHarnessSpec, zoneId?: string): string {
  const base = `assay-harness-${spec.id}-${spec.version}`;
  return zoneId ? `${base}-${zoneId}` : base;
}

export function buildNomadTopologyJob(spec: ServiceHarnessSpec, opts: NomadTopologyOptions = {}): NomadTopologyJobSpec {
  return {
    Job: {
      ID: topologyJobId(spec, opts.zoneId),
      Type: "service",
      Namespace: opts.namespace,
      Datacenters: opts.datacenters ?? ["dc1"],
      TaskGroups: spec.services.map((svc) => {
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
              Env: { ...opts.storeEnv },
              Resources: { CPU: 1000, MemoryMB: 1024 },
            },
          ],
        };
        // port 가 있으면 dynamic port + docker 매핑 → 호스트에서 엔드포인트 발견 가능.
        if (svc.port !== undefined) {
          group.Networks = [{ DynamicPorts: [{ Label: "http", To: svc.port }] }];
          config.ports = ["http"];
        }
        return group;
      }),
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
