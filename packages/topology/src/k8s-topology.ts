import type { ServiceHarnessSpec } from "@assay/core";

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
}

export function buildK8sManifests(spec: ServiceHarnessSpec, opts: K8sTopologyOptions = {}): K8sManifest[] {
  const ns = opts.namespace ?? "assay-platform";
  const env = Object.entries(opts.storeEnv ?? {}).map(([name, value]) => ({ name, value }));
  const out: K8sManifest[] = [];
  for (const svc of spec.services) {
    const labels = { app: svc.name, "assay/harness": spec.id, "assay/version": spec.version };
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
