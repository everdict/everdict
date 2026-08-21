import {
  BadRequestError,
  type RegistryAuth,
  type ServiceHarnessSpec,
  type ServiceReadiness,
  type ServiceResources,
  type TopologyService,
  serviceIsHostExec,
} from "@everdict/contracts";
import {
  UNTRUSTED_POD_IDENTITY,
  dockerAuthConfigJson,
  pickRegistryAuth,
  registryAuthSecretName,
  registryAuthsForImages,
} from "@everdict/domain";
import { DEFAULT_BROWSER_IMAGE } from "./browser-image.js";
import {
  type StoreValues,
  dependencyConnEnv,
  dependencyStoreValues,
  dependencyStores,
  resolveStoreConfig,
  storeArgs,
} from "./dependencies.js";
import { dependencyInjectEnv } from "./inject-env.js";
import { HOST_GATEWAY_KEYWORD, interpolateServiceEnv, staticWiringEnv } from "./nomad-topology.js";
import { k8sPeerHost } from "./peer-resolver.js";

// ServiceResources → k8s container resources (requests=limits). cpu 1000 = 1 core (millicores), memoryMb → Mi. Includes only what is defined.
function k8sResources(r: ServiceResources): { requests: Record<string, string>; limits: Record<string, string> } {
  const q: Record<string, string> = {};
  if (r.cpu !== undefined) q.cpu = `${r.cpu}m`;
  if (r.memoryMb !== undefined) q.memory = `${r.memoryMb}Mi`;
  return { requests: q, limits: q };
}

// docker -v style mount specs → k8s volumes (pod) + volumeMounts (container).
// "/host:/c[:ro]" → hostPath, "named:/c[:ro]" → emptyDir (per-pod ephemeral; persistent PVC is a follow-up). name is sanitized to the k8s spec.
function k8sVolumes(volumes: string[]): {
  volumes: Array<Record<string, unknown>>;
  mounts: Array<Record<string, unknown>>;
} {
  const vols: Array<Record<string, unknown>> = [];
  const mounts: Array<Record<string, unknown>> = [];
  volumes.forEach((v, i) => {
    const [source, mountPath, mode] = v.split(":");
    if (!source || !mountPath) return;
    const slug = source
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    const name = `vol-${i}-${slug || "m"}`.slice(0, 63);
    vols.push(source.startsWith("/") ? { name, hostPath: { path: source } } : { name, emptyDir: {} });
    mounts.push({ name, mountPath, ...(mode === "ro" ? { readOnly: true } : {}) });
  });
  return { volumes: vols, mounts };
}

// ServiceReadiness + port → k8s readinessProbe (httpGet "/"). interval → periodSeconds, timeout/interval → failureThreshold.
function k8sReadinessProbe(r: ServiceReadiness, port: number): Record<string, unknown> {
  const periodSeconds = Math.max(1, Math.round(r.intervalMs / 1000));
  return {
    httpGet: { path: "/", port },
    periodSeconds,
    timeoutSeconds: periodSeconds,
    failureThreshold: Math.max(1, Math.ceil(r.timeoutMs / r.intervalMs)),
  };
}

// Render the warm topology as K8s Deployment/Service (one per service; isolated via runtimeClass).
export interface K8sManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  spec?: unknown; // Namespace etc. have no spec
}

export interface K8sTopologyOptions {
  namespace?: string;
  runtimeClass?: string; // e.g. "gvisor"
  storeEnv?: Record<string, string>;
  // Structured store coordinates for dependencies[].inject (BYO env names). Pool passes the plan's minted values;
  // unset + provisionDependencies (silo) falls back to the build-time defaults (in-namespace Service DNS + root creds).
  storeValues?: Partial<Record<string, StoreValues>>;
  imagePullPolicy?: string; // e.g. "IfNotPresent" (when using pre-loaded images, as with kind)
  provisionDependencies?: boolean; // also deploy spec.dependencies[] (postgres/redis) + auto-inject connection env
  // Image pull credentials (transient) — if a credential covers some service image, render a dockerconfigjson
  // Secret + imagePullSecrets. One Secret holds every covering credential. docs/architecture/managed-image-store.md
  registryAuths?: RegistryAuth[];
  // host.docker.internal → this IP as a pod hostAlias (gap 5). K8s has no docker host, so it is opt-in — set it to the
  // concrete gateway IP to give a K8s-deployed service the SAME host-local reach a Docker/Nomad service gets. The
  // Docker-CLI `host-gateway` keyword is not a valid hostAliases IP, so it is ignored here.
  hostGatewayAddr?: string;
}

// Name of the Secret referenced by imagePullSecrets. CONTENT-ADDRESSED (`registryAuthSecretName`), so an apply
// can only replace it with identical bytes — a namespace-global name made this a destructive upsert between
// topologies holding different grants for one host.

// Workspace registry credentials → a kubernetes.io/dockerconfigjson Secret. buildK8sManifests includes it only when
// some service image's host matches (avoids scattering irrelevant credentials across the cluster).
export function registryAuthSecretManifest(auth: RegistryAuth | RegistryAuth[], ns: string): K8sManifest {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: registryAuthSecretName(auth), namespace: ns, labels: { app: "everdict" } },
    type: "kubernetes.io/dockerconfigjson",
    data: { ".dockerconfigjson": Buffer.from(dockerAuthConfigJson(auth)).toString("base64") },
  } as K8sManifest & { type: string; data: Record<string, string> };
}

// Render shared stores (spec.dependencies[]) as Deployment+Service. Once per (harness-version, ns).
export function buildDependencyManifests(spec: ServiceHarnessSpec, opts: K8sTopologyOptions = {}): K8sManifest[] {
  const ns = opts.namespace ?? "everdict-platform";
  const out: K8sManifest[] = [];
  for (const { store, name, def } of dependencyStores(spec)) {
    const labels = {
      app: name,
      "everdict/harness": spec.id,
      "everdict/version": spec.version,
      "everdict/store": store,
    };
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
            // No cluster identity for a tenant-supplied service image — see `UNTRUSTED_POD_IDENTITY`.
            ...UNTRUSTED_POD_IDENTITY,
            runtimeClassName: opts.runtimeClass,
            containers: [
              {
                name: store,
                image: def.image,
                imagePullPolicy: opts.imagePullPolicy,
                args: storeArgs(store, def, resolveStoreConfig(spec.dependencies, store)), // per-role tuning (plumbing→cache, data→durable)
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

// Narrow a containerized service's image (the schema guarantees the pairing; this guards registry-bypassing callers).
function svcImage(svc: Pick<TopologyService, "name" | "image">): string {
  if (svc.image === undefined) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { service: svc.name },
      `Containerized service "${svc.name}" has no image.`,
    );
  }
  return svc.image;
}

export function buildK8sManifests(spec: ServiceHarnessSpec, opts: K8sTopologyOptions = {}): K8sManifest[] {
  // K8s has no non-container execution path — a host-exec service (raw_exec-style) can't be realized here.
  // Fail fast and honestly instead of rendering a Deployment with no image.
  const hostSvc = spec.services.find((s) => serviceIsHostExec(s));
  if (hostSvc) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { service: hostSvc.name },
      `Host-exec service "${hostSvc.name}" cannot run on K8s (containers only) — use a Nomad runtime (raw_exec) or a host-capable runner.`,
    );
  }
  const ns = opts.namespace ?? "everdict-platform";
  // When stores are brought up too, auto-inject the connection env — precedence: connEnv (convention) < svc.env (service static) < storeEnv (operational override) < dependency inject.
  const depEnv = opts.provisionDependencies ? dependencyConnEnv(spec) : {};
  const storeValues = opts.storeValues ?? (opts.provisionDependencies ? dependencyStoreValues(spec) : {});
  const out: K8sManifest[] = [];
  // Render the dockerconfigjson Secret + imagePullSecrets only when a workspace-registry image is actually present.
  const auths = registryAuthsForImages(opts.registryAuths ?? [], spec.services.map(svcImage));
  if (auths.length > 0) out.push(registryAuthSecretManifest(auths, ns));
  if (opts.provisionDependencies) out.push(...buildDependencyManifests(spec, opts));
  for (const svc of spec.services) {
    const labels = { app: svc.name, "everdict/harness": spec.id, "everdict/version": spec.version };
    // Peer wiring (BYO env names) + {{peer}} refs in svc.env resolve to the peer's stable Service DNS name (<id>-<svc>) — < service env < storeEnv.
    const wiringEnv = staticWiringEnv(svc, spec.services, k8sPeerHost(spec.id));
    const svcEnv = interpolateServiceEnv(svc, spec.services, k8sPeerHost(spec.id));
    const env = Object.entries({
      ...wiringEnv,
      ...depEnv,
      ...svcEnv,
      ...(opts.storeEnv ?? {}),
      ...dependencyInjectEnv(spec, storeValues, svc.name),
    }).map(([name, value]) => ({
      name,
      value,
    }));
    const vm = svc.volumes && svc.volumes.length > 0 ? k8sVolumes(svc.volumes) : { volumes: [], mounts: [] };
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
            // No cluster identity for a tenant-supplied service image — see `UNTRUSTED_POD_IDENTITY`.
            ...UNTRUSTED_POD_IDENTITY,
            runtimeClassName: opts.runtimeClass,
            // Intrinsic OS placement (requires.os) → the standard nodeSelector (kubernetes.io/os = GOOS). This is
            // the K8s realization of the portable os-<x> capability; the whole cross-service data plane (Service DNS)
            // is unchanged, so a Windows service just lands on a Windows node. Cluster taints (if Windows nodes are
            // tainted) are a runtime-side binding, not a harness concern.
            ...(svc.requires?.os
              ? { nodeSelector: { "kubernetes.io/os": svc.requires.os === "macos" ? "darwin" : svc.requires.os } }
              : {}),
            // Image auth — reference the Secret above only when a credential covers THIS service's image.
            ...(pickRegistryAuth(auths, svcImage(svc))
              ? { imagePullSecrets: [{ name: registryAuthSecretName(auths) }] }
              : {}),
            // host.docker.internal parity (gap 5) — opt-in: only when a concrete gateway IP is configured (the Docker
            // "host-gateway" keyword is not a valid K8s hostAliases IP, so it is skipped).
            ...(opts.hostGatewayAddr && opts.hostGatewayAddr !== HOST_GATEWAY_KEYWORD
              ? { hostAliases: [{ ip: opts.hostGatewayAddr, hostnames: ["host.docker.internal"] }] }
              : {}),
            containers: [
              {
                name: svc.name,
                image: svcImage(svc),
                imagePullPolicy: opts.imagePullPolicy,
                ports: svc.port ? [{ containerPort: svc.port }] : [],
                env,
                // Service resource request (svc.resources) → requests=limits. cpu 1000 = 1 core (millicores), memoryMb → Mi. Unset = unlimited (omitted).
                ...(svc.resources ? { resources: k8sResources(svc.resources) } : {}),
                // Service volume mounts (svc.volumes). readinessProbe = httpGet "/" when svc.readiness + port are present.
                ...(vm.mounts.length > 0 ? { volumeMounts: vm.mounts } : {}),
                ...(svc.readiness && svc.port !== undefined
                  ? { readinessProbe: k8sReadinessProbe(svc.readiness, svc.port) }
                  : {}),
              },
            ],
            ...(vm.volumes.length > 0 ? { volumes: vm.volumes } : {}),
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

// Namespace = the tenant (zone) isolation boundary. The primary means of separating the warm pool per zone.
export function namespaceManifest(ns: string): K8sManifest {
  return { apiVersion: "v1", kind: "Namespace", metadata: { name: ns } };
}

export function browserDeployName(runId: string): string {
  return `everdict-browser-${runId}`;
}

export interface K8sBrowserOptions {
  namespace?: string;
  runtimeClass?: string;
  image?: string;
  // The harness's client-extension browser (`target.extension.ref`). Takes precedence over `image` and suppresses
  // the arg override, because such an image loads the extension from its own entrypoint.
  extensionImage?: string;
  cdpPort?: number;
  args?: string[];
  imagePullPolicy?: string;
}

// per-case browser (target env II): a headless Chromium Deployment + Service. Exposes the CDP port.
// `extensionImage` is the harness's declared client-extension browser (`target.extension.ref`) — a headful image
// that loads the extension from its OWN entrypoint. Ignoring it does not fail: the case runs against a plain
// browser with no extension and simply scores badly, so a harness that works on Nomad would quietly mean
// something else here. Nomad's builder has honored it from the start; this keeps the runtimes isomorphic.
export function buildBrowserManifests(runId: string, opts: K8sBrowserOptions = {}): K8sManifest[] {
  const ns = opts.namespace ?? "default";
  const image = opts.extensionImage ?? opts.image ?? DEFAULT_BROWSER_IMAGE;
  const cdpPort = opts.cdpPort ?? 9222;
  const name = browserDeployName(runId);
  const labels = { app: name, "everdict/runId": runId };
  // headless-shell exposes CDP itself on 9222 (socat) → add only allow-origins (do not override the port). An
  // extension image launches Chromium from its own CMD (headful + --load-extension), so passing args would
  // REPLACE that launch line and the extension would never load.
  const args = opts.args ?? (opts.extensionImage ? undefined : ["--remote-allow-origins=*"]);
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
            // No cluster identity for a tenant-supplied service image — see `UNTRUSTED_POD_IDENTITY`.
            ...UNTRUSTED_POD_IDENTITY,
            runtimeClassName: opts.runtimeClass,
            containers: [
              {
                name: "browser",
                image,
                imagePullPolicy: opts.imagePullPolicy,
                // Omitted entirely (not `args: undefined`) for an extension image, so the manifest carries no
                // command override at all and the image's own entrypoint runs.
                ...(args ? { args } : {}),
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
