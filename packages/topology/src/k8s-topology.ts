import type { ServiceHarnessSpec } from "@assay/core";

// warm 토폴로지를 K8s Deployment/Service 로 렌더 (서비스당; runtimeClass 로 격리).
export interface K8sManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  spec: unknown;
}

export interface K8sTopologyOptions {
  namespace?: string;
  runtimeClass?: string; // 예: "gvisor"
  storeEnv?: Record<string, string>;
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
