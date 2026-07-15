import { BadRequestError, type HarnessSpec, type ServiceHarnessSpec, type TopologyService } from "@everdict/contracts";

// Topology portability lint — a pure analyzer that rejects a service HarnessSpec that would resolve to DIFFERENT
// (incompatible) addresses across runtimes, so "works on the self-hosted Docker runner, fails on Nomad/K8s" is caught
// at authoring time instead of as a late, opaque run failure. The one portable way to address a peer is a {{peer}}
// token (the runtime renders the per-backend host + validates needs/port); every literal address (a declared service
// name, localhost, or an IP) only resolves on a subset of backends. See docs/architecture/topology-portability.md.

export type PortabilityRule =
  | "no-literal-host" // localhost / 127.0.0.1 / private IP baked into an address — resolves to the local host only
  | "peer-by-literal" // a declared peer addressed by its literal name — the address differs per runtime; use {{peer}}
  | "needs-complete" // a peer is referenced but not declared in needs — per-service Nomad wires only declared needs
  | "addressed-has-port" // a peer is addressed but declares no port — nothing to publish/forward
  | "reference-not-address" // front-door / target references a service that is not declared
  | "unique-ports"; // two services share a port — the co-located Nomad shared netns forbids it

export interface PortabilityIssue {
  rule: PortabilityRule;
  // error = the construct resolves DIFFERENTLY (or not at all) on another runtime — no legitimate exception, so a new
  // registration is hard-blocked. warning = non-portable but sometimes an intentional self-hosted-only choice (a docker
  // host-gateway IP, a loopback trace endpoint) — surfaced, not blocked, and migrated over time (S2).
  severity: "error" | "warning";
  service?: string; // the offending service, when the issue is service-scoped
  field: string; // a locator, e.g. "services[web].env.API_URL" or "frontDoor.service"
  message: string; // what is wrong + how to make it portable
}

// A structural violation (a peer addressed by its literal name, a missing needs edge, a duplicate port, a dangling
// reference) breaks on another runtime with no legitimate exception → error. A host literal is often an intentional
// self-hosted pattern → warning.
const SEVERITY: Record<PortabilityRule, "error" | "warning"> = {
  "no-literal-host": "warning",
  "peer-by-literal": "error",
  "needs-complete": "error",
  "addressed-has-port": "error",
  "reference-not-address": "error",
  "unique-ports": "error",
};

// Only the issues that hard-block a new registration (used by the registry register + the validate route).
export function portabilityErrors(issues: PortabilityIssue[]): PortabilityIssue[] {
  return issues.filter((i) => i.severity === "error");
}

// Hard-block a non-portable service spec at registration. Called by the registry `register` (the single chokepoint every
// path — HTTP route, bundle apply, MCP — flows through) so a non-portable harness never lands, uniformly. Only
// error-severity (structural) issues block; warnings are surfaced by the caller, not thrown. Non-service specs pass.
export function assertPortable(spec: HarnessSpec): void {
  if (spec.kind !== "service") return;
  const errors = portabilityErrors(checkPortability(spec));
  if (errors.length > 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { portabilityIssues: errors },
      `Harness is not portable across runtimes — fix and re-register: ${errors.map((e) => e.message).join(" ")}`,
    );
}

// A {{peer}} / {{peer.host}} / {{peer.port}} / {{peer.url}} token (double-brace, same convention as the front-door
// bodyTemplate). Mirrors packages/topology PEER_TOKEN_RE so the lint flags at authoring time what the deploy path
// would otherwise only throw at dispatch. (S3 unifies these into one shared util — docs/architecture/topology-portability.md.)
const PEER_TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const LOOPBACK = ["localhost", "127.0.0.1", "0.0.0.0", "::1"];
// A private-range IPv4 used as an address host (RFC 1918). Cluster addresses are runtime-assigned, so a hardcoded one pins to one runtime.
const PRIVATE_IP_RE =
  /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The peer name a token addresses (drop a trailing .host/.port/.url field). Same parse as the deploy path.
function peerName(token: string): string {
  const dot = token.lastIndexOf(".");
  if (dot > 0) {
    const suffix = token.slice(dot + 1);
    if (suffix === "host" || suffix === "port" || suffix === "url") return token.slice(0, dot);
  }
  return token;
}

// Strip {{...}} tokens before the literal scans so a {{peer}} reference is not itself mistaken for a literal address.
function withoutTokens(value: string): string {
  return value.replace(PEER_TOKEN_RE, "");
}

// Is `name` used as a literal host in `value` — as `//name` (URL authority) or `name:<port>`? (Names may contain
// dashes, so plain word boundaries do not apply; require an authority-position delimiter.)
function referencesServiceLiterally(value: string, name: string): boolean {
  const n = escapeRegExp(name);
  return new RegExp(`(?:\\/\\/${n}(?=[:/\\s"']|$))|(?:(?:^|[\\s"'@/])${n}:\\d)`).test(value);
}

export function checkPortability(spec: ServiceHarnessSpec): PortabilityIssue[] {
  const issues: Omit<PortabilityIssue, "severity">[] = [];
  const names = new Set(spec.services.map((s) => s.name));
  const byName = new Map(spec.services.map((s) => [s.name, s]));

  // A referenced peer must be declared in `needs` (per-service Nomad wires only needs) and must expose a `port`.
  const checkPeerRef = (svc: TopologyService, peer: string, field: string): void => {
    if (!svc.needs.includes(peer))
      issues.push({
        rule: "needs-complete",
        service: svc.name,
        field,
        message: `Service "${svc.name}" references peer "${peer}" but does not list it in needs — per-service Nomad wires only declared needs, so this works on Docker but fails there.`,
      });
    if (byName.get(peer)?.port === undefined)
      issues.push({
        rule: "addressed-has-port",
        service: svc.name,
        field,
        message: `Peer "${peer}" is addressed by "${svc.name}" but declares no port — there is nothing to publish or forward.`,
      });
  };

  // A user-authored string that becomes part of an address: flag a loopback/private-IP host and a literal peer-name host.
  const scanLiteral = (field: string, value: string, service?: string): void => {
    const bare = withoutTokens(value);
    const loop = LOOPBACK.find((l) => bare.includes(l));
    if (loop)
      issues.push({
        rule: "no-literal-host",
        ...(service ? { service } : {}),
        field,
        message: `${field} contains "${loop}", which resolves to the local host only — it works in a shared network (Docker / co-located Nomad) but not on K8s or per-service Nomad. Use a {{peer}} token or a runtime-injected variable.`,
      });
    const ip = PRIVATE_IP_RE.exec(bare);
    if (ip)
      issues.push({
        rule: "no-literal-host",
        ...(service ? { service } : {}),
        field,
        message: `${field} hardcodes the private IP "${ip[1]}" — cluster addresses are assigned by the runtime. Use a {{peer}} token or a runtime-injected variable.`,
      });
    for (const n of names)
      if (referencesServiceLiterally(bare, n))
        issues.push({
          rule: "peer-by-literal",
          ...(service ? { service } : {}),
          field,
          message: `${field} addresses peer service "${n}" by its literal name — the address differs per runtime (Docker alias "${n}" vs K8s Service "${spec.id}-${n}"). Use the {{${n}}} token instead.`,
        });
  };

  // Recurse a JSON template (front-door bodyTemplate) to its string leaves.
  const scanJson = (field: string, node: unknown): void => {
    if (typeof node === "string") scanLiteral(field, node);
    else if (Array.isArray(node)) node.forEach((item, i) => scanJson(`${field}[${i}]`, item));
    else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) scanJson(`${field}.${k}`, v);
  };

  const portByService = new Map<number, string>();
  for (const svc of spec.services) {
    if (svc.port !== undefined) {
      const prev = portByService.get(svc.port);
      if (prev !== undefined)
        issues.push({
          rule: "unique-ports",
          service: svc.name,
          field: `services[${svc.name}].port`,
          message: `Port ${svc.port} is also used by "${prev}" — services share one network namespace on co-located Nomad, so ports must be unique across the topology.`,
        });
      else portByService.set(svc.port, svc.name);
    }
    for (const [key, value] of Object.entries(svc.env)) {
      if (typeof value !== "string") continue; // a { secretRef } — no authored address
      const field = `services[${svc.name}].env.${key}`;
      scanLiteral(field, value, svc.name);
      for (const match of value.matchAll(PEER_TOKEN_RE)) {
        const peer = peerName(match[1] ?? "");
        if (names.has(peer)) checkPeerRef(svc, peer, field); // a token naming no service is the harness's own variable
      }
    }
    for (const w of svc.wiring ?? [])
      if (names.has(w.service)) checkPeerRef(svc, w.service, `services[${svc.name}].wiring`);
  }

  if (!names.has(spec.frontDoor.service))
    issues.push({
      rule: "reference-not-address",
      field: "frontDoor.service",
      message: `frontDoor.service "${spec.frontDoor.service}" is not a declared service — the front door must reference a service by name (its address is resolved per runtime), never a hardcoded URL.`,
    });
  if (spec.frontDoor.request?.bodyTemplate)
    scanJson("frontDoor.request.bodyTemplate", spec.frontDoor.request.bodyTemplate);
  for (const [k, v] of Object.entries(spec.frontDoor.request?.headers ?? {}))
    scanLiteral(`frontDoor.request.headers.${k}`, v);

  const acquire = spec.target?.acquire;
  if (acquire?.mode === "service") {
    if (!names.has(acquire.service))
      issues.push({
        rule: "reference-not-address",
        field: "target.acquire.service",
        message: `target.acquire.service "${acquire.service}" is not a declared service.`,
      });
    if (acquire.ready?.service && !names.has(acquire.ready.service))
      issues.push({
        rule: "reference-not-address",
        field: "target.acquire.ready.service",
        message: `target.acquire.ready.service "${acquire.ready.service}" is not a declared service.`,
      });
  }

  // A loopback trace endpoint is only reachable when the control plane is co-located — non-portable like the rest.
  scanLiteral("traceSource.endpoint", spec.traceSource.endpoint);

  return issues.map((i) => ({ ...i, severity: SEVERITY[i.rule] }));
}
