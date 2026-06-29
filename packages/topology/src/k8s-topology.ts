import type { ServiceHarnessSpec, ServiceResources } from "@assay/core";
import { dependencyConnEnv, dependencyStores } from "./dependencies.js";

// ServiceResources → k8s container resources(requests=limits). cpu 1000=1코어(millicores), memoryMb→Mi. 정의된 것만 포함.
function k8sResources(r: ServiceResources): { requests: Record<string, string>; limits: Record<string, string> } {
  const q: Record<string, string> = {};
  if (r.cpu !== undefined) q.cpu = `${r.cpu}m`;
  if (r.memoryMb !== undefined) q.memory = `${r.memoryMb}Mi`;
  return { requests: q, limits: q };
}

// warm 토폴로지를 K8s Deployment/Service 로 렌더 (서비스당; runtimeClass 로 격리).
export interface K8sManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  spec?: unknown; // Namespace 등은 spec 이 없다
}

export interface K8sTopologyOptions {
  namespace?: string;
  runtimeClass?: string; // 예: "gvisor"
  storeEnv?: Record<string, string>;
  imagePullPolicy?: string; // 예: "IfNotPresent" (kind 처럼 사전 로드한 이미지를 쓸 때)
  provisionDependencies?: boolean; // spec.dependencies[](postgres/redis)도 함께 배포 + 접속 env 자동 주입
}

// 공유 스토어(spec.dependencies[])를 Deployment+Service 로 렌더. (harness-version, ns) 당 한 번.
export function buildDependencyManifests(spec: ServiceHarnessSpec, opts: K8sTopologyOptions = {}): K8sManifest[] {
  const ns = opts.namespace ?? "assay-platform";
  const out: K8sManifest[] = [];
  for (const { store, name, def } of dependencyStores(spec)) {
    const labels = { app: name, "assay/harness": spec.id, "assay/version": spec.version, "assay/store": store };
    const env = Object.entries(def.env ?? {}).map(([n, value]) => ({ name: n, value }));
    out.push({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name, namespace: ns, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels },
          spec: {
            runtimeClassName: opts.runtimeClass,
            containers: [
              {
                name: store,
                image: def.image,
                imagePullPolicy: opts.imagePullPolicy,
                args: def.args,
                env,
                ports: [{ containerPort: def.port }],
              },
            ],
          },
        },
      },
    });
    out.push({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name, namespace: ns },
      spec: { selector: { app: name }, ports: [{ port: def.port, targetPort: def.port }] },
    });
  }
  return out;
}

export function buildK8sManifests(spec: ServiceHarnessSpec, opts: K8sTopologyOptions = {}): K8sManifest[] {
  const ns = opts.namespace ?? "assay-platform";
  // 스토어를 함께 띄우면 접속 env 를 자동 주입 — 우선순위: connEnv(관례) < svc.env(서비스 정적) < storeEnv(운영 오버라이드).
  const depEnv = opts.provisionDependencies ? dependencyConnEnv(spec) : {};
  const out: K8sManifest[] = [];
  if (opts.provisionDependencies) out.push(...buildDependencyManifests(spec, opts));
  for (const svc of spec.services) {
    const labels = { app: svc.name, "assay/harness": spec.id, "assay/version": spec.version };
    const env = Object.entries({ ...depEnv, ...svc.env, ...(opts.storeEnv ?? {}) }).map(([name, value]) => ({
      name,
      value,
    }));
    out.push({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: `${spec.id}-${svc.name}`, namespace: ns, labels },
      spec: {
        replicas: svc.replicas,
        selector: { matchLabels: { app: svc.name } },
        template: {
          metadata: { labels },
          spec: {
            runtimeClassName: opts.runtimeClass,
            containers: [
              {
                name: svc.name,
                image: svc.image,
                imagePullPolicy: opts.imagePullPolicy,
                ports: svc.port ? [{ containerPort: svc.port }] : [],
                env,
                // 서비스 리소스 요청(svc.resources) → requests=limits. cpu 1000=1코어(millicores), memoryMb→Mi. 미설정=무제한(생략).
                ...(svc.resources ? { resources: k8sResources(svc.resources) } : {}),
              },
            ],
          },
        },
      },
    });
    if (svc.port) {
      out.push({
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: `${spec.id}-${svc.name}`, namespace: ns },
        spec: { selector: { app: svc.name }, ports: [{ port: svc.port, targetPort: svc.port }] },
      });
    }
  }
  return out;
}

// 네임스페이스 = 테넌트(존) 격리 경계. warm 풀을 존별로 분리하는 1차 수단.
export function namespaceManifest(ns: string): K8sManifest {
  return { apiVersion: "v1", kind: "Namespace", metadata: { name: ns } };
}

export function browserDeployName(runId: string): string {
  return `assay-browser-${runId}`;
}

export interface K8sBrowserOptions {
  namespace?: string;
  runtimeClass?: string;
  image?: string;
  cdpPort?: number;
  args?: string[];
  imagePullPolicy?: string;
}

// per-case 브라우저(타깃 환경 II): headless Chromium Deployment + Service. CDP 포트 노출.
export function buildBrowserManifests(runId: string, opts: K8sBrowserOptions = {}): K8sManifest[] {
  const ns = opts.namespace ?? "default";
  const image = opts.image ?? "chromedp/headless-shell:latest";
  const cdpPort = opts.cdpPort ?? 9222;
  const name = browserDeployName(runId);
  const labels = { app: name, "assay/runId": runId };
  // headless-shell 은 CDP 를 스스로 9222(socat)로 노출 → allow-origins 만 추가(포트 덮어쓰기 금지).
  const args = opts.args ?? ["--remote-allow-origins=*"];
  return [
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name, namespace: ns, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels },
          spec: {
            runtimeClassName: opts.runtimeClass,
            containers: [
              {
                name: "browser",
                image,
                imagePullPolicy: opts.imagePullPolicy,
                args,
                ports: [{ containerPort: cdpPort }],
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name, namespace: ns },
      spec: { selector: { app: name }, ports: [{ port: cdpPort, targetPort: cdpPort }] },
    },
  ];
}
