import { BadRequestError, type RegistryAuth, type ServiceHarnessSpec } from "@everdict/contracts";
import { flattenEnv, imageUsesRegistryHost } from "@everdict/domain";
import { dependencyStores } from "./dependencies.js";
import { sanitizeIdent } from "./store-binding.js";

// Render the warm topology as a Nomad service job. All of a topology's service tasks are CO-LOCATED in ONE task
// group (one alloc, one bridge network namespace), mirroring the docker runtime's fixed internal-address model:
// services reach each other over loopback (localhost:<svc.port>), so an inter-service address never depends on a
// dynamically-assigned host port and never goes stale when the alloc reschedules (the whole topology reschedules
// atomically). Each service also publishes a group dynamic host port (so the control plane can reach the front-door),
// and extra_hosts maps every service name → 127.0.0.1 so a harness addressing a peer by <svc.name>:<port> (the
// docker/k8s convention) resolves to loopback too — one harness definition, identical wiring across docker/k8s/nomad.
// Shared-store endpoints are injected via storeEnv (discovered host:port). Per-run wiring is separate, via the front-door API.
// See docs/architecture/nomad-colocated-topology.md.
interface NomadTopoTask {
  Name: string;
  Driver: string;
  Config: {
    image: string;
    runtime?: string;
    ports?: string[];
    args?: string[];
    volumes?: string[];
    // Loopback host aliases (docker driver `extra_hosts`, "name:ip") — every peer service name → 127.0.0.1 within the shared netns.
    extra_hosts?: string[];
    // docker driver registry auth (the JSON-API representation of the HCL auth block = an array) — for pulling workspace-registry images.
    auth?: Array<{ username: string; password: string }>;
  };
  Env: Record<string, string>;
  Resources: { CPU: number; MemoryMB: number };
  // Rendered templates (peer address discovery for the per-service-group model — Nomad-native service catalog → env).
  Templates?: NomadTemplate[];
}
// Nomad template stanza — renders the service catalog into an env file so a service reaches its peers by address
// (the Nomad-native, no-Consul analog of K8s Service DNS). ChangeMode "restart" re-resolves on a peer reschedule.
interface NomadTemplate {
  EmbeddedTmpl: string;
  DestPath: string;
  Envvars?: boolean;
  ChangeMode?: string;
}
// Group placement constraint (e.g. ${attr.kernel.name} = windows) — the Nomad realization of the os-<x> capability.
interface NomadConstraint {
  LTarget: string;
  Operand: string;
  RTarget: string;
}
// Nomad-native service registration (provider "nomad") — no Consul required; peers discover it via the catalog.
interface NomadNativeService {
  Name: string;
  PortLabel?: string;
  Provider: string;
}
interface NomadDynamicPort {
  Label: string;
  To: number;
}
interface NomadNetwork {
  Mode?: string; // Connect requires "bridge"
  DynamicPorts: NomadDynamicPort[];
}
// Consul Connect: group service + Envoy sidecar (+ upstreams to other mesh services). The mesh enforces via intentions.
export interface NomadConnectUpstream {
  DestinationName: string;
  LocalBindPort: number;
}
export interface NomadConnectService {
  Name: string; // mesh service name t-<zone>-<svc>
  PortLabel: string;
  Connect: { SidecarService: { Proxy?: { Upstreams: NomadConnectUpstream[] } } };
}
interface NomadTopoGroup {
  Name: string;
  Count: number;
  Networks?: NomadNetwork[];
  Constraints?: NomadConstraint[];
  Services?: Array<NomadConnectService | NomadNativeService>;
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
  runtime?: string; // isolation runtime (e.g. "runsc")
  namespace?: string;
  storeEnv?: Record<string, string>; // shared-store endpoints etc.
  zoneId?: string; // trust-zone (tenant) identifier — mixed into the warm job ID to prevent cross-tenant sharing
  provisionDependencies?: boolean; // also deploy spec.dependencies[] (postgres/redis) as task groups in the same job
  // Workspace image-registry pull credentials (transient) — render the docker auth block only on tasks whose service
  // image host matches. docs/architecture/workspace-image-registry.md
  registryAuth?: RegistryAuth;
}

// Connect group service (sidecar + upstream). A standalone building block for the live Consul-Connect enforcement
// proof (scripts/live/connect-enforce-nomad.mjs). NOT wired by buildNomadTopologyJob anymore: co-located services
// share one netns and talk over loopback, so an inter-service mesh (sidecars/upstreams) is redundant. Cross-tenant
// isolation is the per-(spec,version,zone) job/namespace/netns separation; buildTenantIntentions remains the
// cross-tenant authorization decision (and governs a Connect-enabled external front-door gateway, if operated).
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
  const base = `everdict-harness-${spec.id}-${spec.version}`;
  return zoneId ? `${base}-${zoneId}` : base;
}

// Render shared stores (spec.dependencies[]) as Nomad task groups (one per type). Exposed via dynamic port "store" →
// the runtime discovers the host port and wires it into the service storeEnv (K8s fixes it at build time via DNS, Nomad discovers at runtime).
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

// pool shared-store job — one per cluster (tenant-agnostic). Group name = everdict-shared-<store>, dynamic port "store".
// The runtime deploys this job once and discovers host:port → used as the endpoint for the per-tenant scoped creds.
export const SHARED_STORE_JOB_ID = "everdict-shared-stores";
export function buildSharedStoreJob(stores: string[], opts: NomadTopologyOptions = {}): NomadTopologyJobSpec {
  const spec = {
    id: "everdict-shared",
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

// silo dedicated-store job — a separate (dedicated) store instance per tenant (zone). Group name = everdict-store-<zone>-<store>.
// The runtime brings it up and discovers host:port to wire into the service connEnv (same discover-then-inject as pool, no DDL).
export function dedicatedStoreJobId(spec: ServiceHarnessSpec, zoneId: string): string {
  return `everdict-store-${spec.id}-${sanitizeIdent(zoneId)}`;
}
export function dedicatedStoreGroup(zoneId: string, store: string): string {
  return `everdict-store-${sanitizeIdent(zoneId)}-${store}`;
}
export function buildDedicatedStoreJob(
  spec: ServiceHarnessSpec,
  stores: string[],
  zoneId: string,
  opts: NomadTopologyOptions = {},
): NomadTopologyJobSpec {
  const synth = {
    id: `everdict-store-${sanitizeIdent(zoneId)}`,
    dependencies: [...new Set(stores)].map((store) => ({ store, role: "dedicated", isolateBy: "schema" })),
    services: [],
  } as unknown as ServiceHarnessSpec;
  return {
    Job: {
      ID: dedicatedStoreJobId(spec, zoneId),
      Type: "service",
      Namespace: opts.namespace,
      Datacenters: opts.datacenters ?? ["dc1"],
      TaskGroups: buildDependencyGroups(synth, opts), // group name = everdict-store-<zone>-<store>
    },
  };
}

// The single co-located service group. All service tasks share this group's bridge netns (loopback comms). Named
// distinctly from the per-store dependency groups (<id>-<store>). The runtime discovers ports from this group's one alloc.
export const SERVICE_GROUP_NAME = "everdict-services";

// Nomad port label for a service's exposed port. The one co-located alloc carries EVERY service's port, so the labels
// must be distinct — derive each from the (unique) service name, sanitized to the Nomad port-label / env-var charset.
export function servicePortLabel(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

// Group placement constraint for a service's intrinsic OS — the Nomad realization of the os-<x> capability.
function osConstraint(os: "linux" | "windows" | "macos" | undefined): NomadConstraint {
  return {
    LTarget: "${attr.kernel.name}",
    Operand: "=",
    RTarget: os === "windows" ? "windows" : os === "macos" ? "darwin" : "linux",
  };
}

// Does the topology need per-service groups (K8s-style) instead of the single co-located group? True when it is
// heterogeneous (a service needs a non-Linux OS, so it can't share a Linux netns) OR scaled (replicas>1 can't bind
// the same port twice in a shared netns). A homogeneous, single-instance Linux topology stays co-located (no regression).
export function needsPerServiceGroups(spec: ServiceHarnessSpec): boolean {
  return spec.services.some((s) => (s.requires?.os ?? "linux") !== "linux" || s.replicas > 1);
}

// Nomad-native service name a peer registers under (stable per harness/service/zone → discoverable via the catalog).
// A Nomad service name must be RFC 1123 (lowercase alphanumeric + dashes, ≤63 chars) — NOT sanitizeIdent, which is
// for DB identifiers (underscores + a disambiguating hash) and would be rejected by Nomad's service validation.
export function nomadServiceName(spec: ServiceHarnessSpec, svc: string, zoneId?: string): string {
  const rfc1123 = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return ["everdict", spec.id, svc, ...(zoneId ? [zoneId] : [])].map(rfc1123).join("-").slice(0, 63).replace(/-+$/, "");
}

// Env var a service reads to reach a peer by address (the injected-peer-address contract for the per-service model,
// since Nomad has no DNS without Consul). E.g. peer "browser-mcp" → EVERDICT_SVC_BROWSER_MCP=http://<ip>:<port>.
export function peerEnvName(svc: string): string {
  return `EVERDICT_SVC_${svc.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function buildNomadTopologyJob(spec: ServiceHarnessSpec, opts: NomadTopologyOptions = {}): NomadTopologyJobSpec {
  const serviceGroups = needsPerServiceGroups(spec)
    ? buildPerServiceGroups(spec, opts)
    : [buildColocatedGroup(spec, opts)];
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

function serviceConfig(
  svc: ServiceHarnessSpec["services"][number],
  opts: NomadTopologyOptions,
): NomadTopoTask["Config"] {
  const auth = opts.registryAuth;
  const config: NomadTopoTask["Config"] = opts.runtime
    ? { image: svc.image, runtime: opts.runtime }
    : { image: svc.image };
  if (auth && imageUsesRegistryHost(svc.image, auth.host))
    config.auth = [{ username: auth.username ?? "everdict", password: auth.password }];
  if (svc.volumes && svc.volumes.length > 0) config.volumes = svc.volumes;
  return config;
}

// The co-located single group — the homogeneous single-instance Linux path. Byte-identical to the pre-existing behavior.
function buildColocatedGroup(spec: ServiceHarnessSpec, opts: NomadTopologyOptions): NomadTopoGroup {
  // Shared netns ⇒ a port can be bound by only one service. Fail fast with a clear error rather than an opaque bind failure.
  const portOwner = new Map<number, string>();
  for (const svc of spec.services) {
    if (svc.port === undefined) continue;
    const existing = portOwner.get(svc.port);
    if (existing !== undefined) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { port: svc.port, services: [existing, svc.name] },
        `Co-located Nomad services cannot share a port: "${existing}" and "${svc.name}" both use ${svc.port}.`,
      );
    }
    portOwner.set(svc.port, svc.name);
  }
  // Map every service name → loopback so a harness addressing a peer by <svc.name>:<port> resolves to localhost inside
  // the shared netns (docker/k8s alias parity). Literal localhost:<port> works regardless — this just adds the name form.
  const extraHosts = spec.services.map((svc) => `${svc.name}:127.0.0.1`);
  const dynamicPorts: NomadDynamicPort[] = [];
  const tasks: NomadTopoTask[] = spec.services.map((svc) => {
    const config = serviceConfig(svc, opts);
    if (extraHosts.length > 0) config.extra_hosts = extraHosts;
    if (svc.port !== undefined) {
      const label = servicePortLabel(svc.name);
      dynamicPorts.push({ Label: label, To: svc.port });
      config.ports = [label];
    }
    return {
      Name: svc.name,
      Driver: "docker",
      Config: config,
      Env: { ...flattenEnv(svc.env), ...opts.storeEnv },
      Resources: { CPU: svc.resources?.cpu ?? 1000, MemoryMB: svc.resources?.memoryMb ?? 1024 },
    };
  });
  return {
    Name: SERVICE_GROUP_NAME,
    Count: 1,
    Networks: [{ Mode: "bridge", DynamicPorts: dynamicPorts }],
    Tasks: tasks,
  };
}

// The K8s-style path: one group per service, placed by its OS constraint, scaled by its replicas, registered in
// Nomad-native discovery (Consul optional), peers resolved by an injected EVERDICT_SVC_<PEER> address (no DNS needed).
function buildPerServiceGroups(spec: ServiceHarnessSpec, opts: NomadTopologyOptions): NomadTopoGroup[] {
  return spec.services.map((svc) => {
    const config = serviceConfig(svc, opts);
    const label = servicePortLabel(svc.name);
    if (svc.port !== undefined) config.ports = [label];
    // Peer discovery: render each declared `needs` peer's address into env from the native catalog (ChangeMode restart
    // so a peer reschedule re-resolves). Only `needs` edges — a service with no needs gets no template. The no-DNS
    // Nomad analog of K8s Service DNS.
    const peers = spec.services.filter((p) => svc.needs.includes(p.name) && p.port !== undefined);
    const template: NomadTemplate | undefined =
      peers.length > 0
        ? {
            EmbeddedTmpl: peers
              .map(
                (p) =>
                  `{{ range nomadService "${nomadServiceName(spec, p.name, opts.zoneId)}" }}${peerEnvName(p.name)}=http://{{ .Address }}:{{ .Port }}{{ end }}\n`,
              )
              .join(""),
            DestPath: "local/peers.env",
            Envvars: true,
            ChangeMode: "restart",
          }
        : undefined;
    const task: NomadTopoTask = {
      Name: svc.name,
      Driver: "docker",
      Config: config,
      Env: { ...flattenEnv(svc.env), ...opts.storeEnv },
      Resources: { CPU: svc.resources?.cpu ?? 1000, MemoryMB: svc.resources?.memoryMb ?? 1024 },
      ...(template ? { Templates: [template] } : {}),
    };
    // Windows/macOS groups can't use the Linux bridge netns — omit Mode (host networking) there.
    const kernel = svc.requires?.os ?? "linux";
    const network: NomadNetwork | undefined =
      svc.port !== undefined
        ? { ...(kernel === "linux" ? { Mode: "bridge" } : {}), DynamicPorts: [{ Label: label, To: svc.port }] }
        : undefined;
    return {
      Name: `everdict-svc-${label}`,
      Count: svc.replicas,
      Constraints: [osConstraint(svc.requires?.os)],
      ...(network ? { Networks: [network] } : {}),
      ...(svc.port !== undefined
        ? { Services: [{ Name: nomadServiceName(spec, svc.name, opts.zoneId), PortLabel: label, Provider: "nomad" }] }
        : {}),
      Tasks: [task],
    };
  });
}

// --- per-case browser (target env II): a fresh headful/headless Chromium + CDP. ---
// Real extension loading (--load-extension) needs headful + an extension image → Phase 2 (user images).
export interface BrowserJobOptions {
  datacenters?: string[];
  runtime?: string;
  namespace?: string;
  image?: string;
  cdpPort?: number;
  args?: string[];
}

export function browserJobId(runId: string): string {
  return `everdict-browser-${runId}`;
}

export function buildBrowserJob(
  spec: ServiceHarnessSpec,
  runId: string,
  opts: BrowserJobOptions = {},
): NomadTopologyJobSpec {
  const image = opts.image ?? "chromedp/headless-shell:latest";
  const cdpPort = opts.cdpPort ?? 9222;
  // chromedp/headless-shell already exposes CDP on 9222 (socat → internal 9223).
  // Overriding the port/address directly collides with the socat listener → CDP won't come up. Add only allow-origins (permit ws connections).
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
              Env: { EVERDICT_RUN_ID: runId, EVERDICT_TARGET: spec.target?.engine ?? "chromium" },
              Resources: { CPU: 1000, MemoryMB: 1024 },
            },
          ],
        },
      ],
    },
  };
}

// --- Discover the mapped host port from the alloc (pure/deterministic). ---
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

// Match the label in order: AllocatedResources.Shared.Ports (new) → Resources.Networks (old).
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
