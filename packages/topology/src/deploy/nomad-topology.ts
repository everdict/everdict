import { BadRequestError, type RegistryAuth, type ServiceHarnessSpec, type TopologyService } from "@everdict/contracts";
import { flattenEnv, imageUsesRegistryHost } from "@everdict/domain";
import { dependencyStores } from "./dependencies.js";
import { aliasPeerHost } from "./peer-resolver.js";
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

// The Nomad group name for a service in the per-service (heterogeneous/scaled) model — one group per service, so the
// runtime waits for and discovers each independently (unlike the co-located SERVICE_GROUP_NAME single group).
export function perServiceGroupName(name: string): string {
  return `everdict-svc-${servicePortLabel(name)}`;
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

// Static peer-coordinate env (TopologyService.wiring) for runtimes where a peer's address is known at build time:
// co-located Nomad/Docker (loopback/alias) and K8s (Service DNS). `hostFor` maps a peer → its build-time host.
export function staticWiringEnv(
  svc: TopologyService,
  services: TopologyService[],
  hostFor: (peer: TopologyService) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of svc.wiring ?? []) {
    const peer = services.find((s) => s.name === w.service);
    if (!peer || peer.port === undefined) continue;
    const host = hostFor(peer);
    if (w.hostEnv) out[w.hostEnv] = host;
    if (w.portEnv) out[w.portEnv] = String(peer.port);
    if (w.urlEnv) out[w.urlEnv] = `http://${host}:${peer.port}`;
  }
  return out;
}

// Peer-reference tokens in a service's env values: {{peer}} / {{peer.url}} → the peer's http://host:port URL,
// {{peer.host}} → host, {{peer.port}} → port. Service names may contain dashes but no dots, so a trailing
// .host/.port/.url is the field and everything before it is the peer name. A token that names no declared service is
// left verbatim (it is the harness's own template, not a peer reference). Double-brace convention — same as the
// front-door bodyTemplate / CommandHarness {{task}}. See docs/service-harness.md (peer env interpolation).
const PEER_TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
type PeerField = "host" | "port" | "url";
function parsePeerToken(token: string): { peer: string; field: PeerField } {
  const dot = token.lastIndexOf(".");
  if (dot > 0) {
    const suffix = token.slice(dot + 1);
    if (suffix === "host" || suffix === "port" || suffix === "url") return { peer: token.slice(0, dot), field: suffix };
  }
  return { peer: token, field: "url" };
}
// Replace every peer token in one env value. `render` produces the substitution for a validated peer service (given its
// guaranteed port); a token that names no service is left verbatim. Shared by the static (build-time address) and
// per-service Nomad (runtime catalog template) modes so the needs/port validation never diverges.
// Fail-fast (no silent pass-through) when a token names a real service that the service does NOT declare in `needs`, or a
// peer that exposes no port — that is a misconfiguration the harness author must fix.
function interpolatePeerTokens(
  value: string,
  svc: TopologyService,
  services: TopologyService[],
  render: (peer: TopologyService, field: PeerField, port: number) => string,
): string {
  return value.replace(PEER_TOKEN_RE, (whole, token: string) => {
    const { peer, field } = parsePeerToken(token);
    const target = services.find((s) => s.name === peer);
    if (!target) return whole; // not a peer reference — leave the harness's own template intact
    if (!svc.needs.includes(peer))
      throw new BadRequestError(
        "BAD_REQUEST",
        { service: svc.name, peer },
        `Service "${svc.name}" env references peer "${peer}" but does not declare it in needs.`,
      );
    if (target.port === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { service: svc.name, peer },
        `Service "${svc.name}" env references peer "${peer}", which exposes no port.`,
      );
    return render(target, field, target.port);
  });
}

// Static peer-endpoint interpolation of a service's env — for runtimes where a peer's address is known at BUILD time:
// docker (network alias), co-located Nomad (loopback name via extra_hosts) and K8s (Service DNS). `hostFor` maps a peer
// service → that build-time host (the SAME mapping staticWiringEnv uses). One pass, no waves: alias+port are static.
// Per-service Nomad (dynamic host ports) resolves peers via its runtime catalog template instead — peerTemplateEnv below.
export function interpolateServiceEnv(
  svc: TopologyService,
  services: TopologyService[],
  hostFor: (peer: TopologyService) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(flattenEnv(svc.env)))
    out[k] = interpolatePeerTokens(v, svc, services, (peer, field, port) => {
      const host = hostFor(peer);
      return field === "host" ? host : field === "port" ? String(port) : `http://${host}:${port}`;
    });
  return out;
}

// Per-service Nomad: split a service's env into the plain values (no peer token → the task Env, set directly) and the
// values that reference a peer (→ a peers.env template line, so consul-template resolves the peer's host:port from the
// native catalog at runtime — the same re-resolving mechanism the EVERDICT_SVC_<PEER>/wiring lines use). A peer token
// renders to the catalog range for that service; the needs/port validation is shared with the static path.
function peerTemplateEnv(
  svc: TopologyService,
  spec: ServiceHarnessSpec,
  zoneId?: string,
): { staticEnv: Record<string, string>; templateLines: string[] } {
  const staticEnv: Record<string, string> = {};
  const templateLines: string[] = [];
  for (const [k, v] of Object.entries(flattenEnv(svc.env))) {
    const rendered = interpolatePeerTokens(v, svc, spec.services, (peer, field) => {
      const inner =
        field === "host" ? "{{ .Address }}" : field === "port" ? "{{ .Port }}" : "http://{{ .Address }}:{{ .Port }}";
      return `{{ range nomadService "${nomadServiceName(spec, peer.name, zoneId)}" }}${inner}{{ end }}`;
    });
    if (rendered === v)
      staticEnv[k] = v; // no peer token — a plain static env var
    else templateLines.push(`${k}=${rendered}`); // ≥1 peer token — runtime-resolved via the template file
  }
  return { staticEnv, templateLines };
}

// The per-service discovery template body: for each `needs` peer the default EVERDICT_SVC_<PEER>, plus each `wiring`
// entry's BYO env names — all rendered from the Nomad-native catalog (host/port resolved at runtime, re-resolving).
function discoveryTemplateBody(svc: TopologyService, spec: ServiceHarnessSpec, zoneId?: string): string {
  const range = (peer: string, body: string): string =>
    `{{ range nomadService "${nomadServiceName(spec, peer, zoneId)}" }}${body}{{ end }}\n`;
  const lines: string[] = [];
  for (const p of spec.services.filter((p) => svc.needs.includes(p.name) && p.port !== undefined))
    lines.push(range(p.name, `${peerEnvName(p.name)}=http://{{ .Address }}:{{ .Port }}`));
  for (const w of svc.wiring ?? []) {
    const peer = spec.services.find((s) => s.name === w.service);
    if (!peer || peer.port === undefined) continue;
    if (w.hostEnv) lines.push(range(peer.name, `${w.hostEnv}={{ .Address }}`));
    if (w.portEnv) lines.push(range(peer.name, `${w.portEnv}={{ .Port }}`));
    if (w.urlEnv) lines.push(range(peer.name, `${w.urlEnv}=http://{{ .Address }}:{{ .Port }}`));
  }
  return lines.join("");
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
  // host.docker.internal → the docker host gateway (Docker 20.10+), so a service that calls a host-local model gateway
  // (LiteLLM etc.) reaches it — parity with the Docker/DockerDriver paths. Both topology group builders start from this;
  // the co-located builder appends peer loopback aliases on top.
  config.extra_hosts = ["host.docker.internal:host-gateway"];
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
    // Append peer loopback aliases to the host-gateway alias already set by serviceConfig (don't clobber it).
    config.extra_hosts = [...(config.extra_hosts ?? []), ...extraHosts];
    if (svc.port !== undefined) {
      const label = servicePortLabel(svc.name);
      dynamicPorts.push({ Label: label, To: svc.port });
      config.ports = [label];
    }
    return {
      Name: svc.name,
      Driver: "docker",
      Config: config,
      // Peer wiring (co-located = loopback alias <peer>) < service static env (with {{peer}} refs → loopback URL) < operational storeEnv.
      Env: {
        ...staticWiringEnv(svc, spec.services, aliasPeerHost),
        ...interpolateServiceEnv(svc, spec.services, aliasPeerHost),
        ...opts.storeEnv,
      },
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
    // Peer discovery: render each declared `needs` peer's address (default EVERDICT_SVC_<PEER>) + each `wiring` entry's
    // BYO env name + any {{peer}}-referencing svc.env value into env from the native catalog (ChangeMode restart so a
    // peer reschedule re-resolves). A service with no such reference gets no template. The no-DNS Nomad analog of K8s DNS.
    const { staticEnv, templateLines } = peerTemplateEnv(svc, spec, opts.zoneId);
    const body = discoveryTemplateBody(svc, spec, opts.zoneId) + templateLines.map((l) => `${l}\n`).join("");
    const template: NomadTemplate | undefined = body
      ? { EmbeddedTmpl: body, DestPath: "local/peers.env", Envvars: true, ChangeMode: "restart" }
      : undefined;
    const task: NomadTopoTask = {
      Name: svc.name,
      Driver: "docker",
      Config: config,
      Env: { ...staticEnv, ...opts.storeEnv },
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
      Name: perServiceGroupName(svc.name),
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
// Client extension (target.extension.ref): a browser image with the extension baked + LOADED — a headful Chromium
// (Xvfb) whose entrypoint runs `--load-extension` and exposes CDP on 9222. Extensions don't load in headless-shell,
// so when an extension is declared we run that user image AS-IS (its own CMD drives Chromium) instead of the default
// headless-shell (which can't load extensions). This closes the former Phase-2 stub. See docs/service-harness.md.
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
  // A declared client extension → the user's headful browser+extension image (it loads the extension + serves CDP).
  const extensionImage = spec.target?.extension?.ref;
  const image = extensionImage ?? opts.image ?? "chromedp/headless-shell:latest";
  const cdpPort = opts.cdpPort ?? 9222;
  // chromedp/headless-shell already exposes CDP on 9222 (socat → internal 9223): override only allow-origins (permit ws
  // connections). An extension image drives Chromium via its OWN entrypoint (headful + --load-extension), so DON'T
  // override its CMD with args here (that would replace the entrypoint's launch).
  const args = opts.args ?? (extensionImage ? undefined : ["--remote-allow-origins=*"]);
  const config: NomadTopoTask["Config"] = { image, ports: ["cdp"] };
  if (args) config.args = args;
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
