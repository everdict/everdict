import type { TrustZone } from "@everdict/core";

// Enforce tenant (zone) network isolation via K8s NetworkPolicy. zone.network picks the policy:
//   deny-cross-tenant = block ingress from outside the same ns (applied symmetrically, so even without egress it blocks cross pod-to-pod reach) — the safe default.
//   deny-egress       = additionally restrict egress to only DNS + same-ns + shared store + allowed CIDRs (block data exfiltration).
//   open              = no policy.
// Note: kubectl port-forward (control-plane→kubelet→pod) bypasses the CNI pod-network, so endpoint discovery/driving
//       is unaffected by this policy. Enforcement needs a policy CNI (Calico/Cilium) (kindnet does not enforce).
export interface NetworkPolicyManifest {
  apiVersion: "networking.k8s.io/v1";
  kind: "NetworkPolicy";
  metadata: { name: string; namespace: string };
  spec: Record<string, unknown>;
}

// Label marking an everdict-created namespace — matched when shared-store ingress allows "only platform namespaces".
export const MANAGED_LABEL = { key: "everdict/managed", value: "true" } as const;

export interface ZoneNetworkPolicyOptions {
  namespace: string;
  network: TrustZone["network"];
  poolNamespace?: string; // pool shared-store ns (allow egress to it under deny-egress)
  storePorts?: number[]; // shared-store ports (e.g. [5432, 6379])
  dnsNamespace?: string; // default kube-system
  egressAllowCIDRs?: string[]; // external allowed CIDRs such as model endpoints (deny-egress)
}

export function buildZoneNetworkPolicies(opts: ZoneNetworkPolicyOptions): NetworkPolicyManifest[] {
  const { namespace, network } = opts;
  if (network === "open") return [];
  const out: NetworkPolicyManifest[] = [];

  // ingress: same ns only. Blocks another tenant's ns from initiating a connection to this zone's pods (the core of cross-tenant blocking).
  out.push({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "everdict-zone-ingress", namespace },
    spec: {
      podSelector: {},
      policyTypes: ["Ingress"],
      ingress: [{ from: [{ podSelector: {} }] }], // podSelector{} (no namespaceSelector) = same ns
    },
  });

  if (network === "deny-egress") {
    const dnsNs = opts.dnsNamespace ?? "kube-system";
    const egress: Array<Record<string, unknown>> = [
      { to: [{ podSelector: {} }] }, // same ns
      {
        to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": dnsNs } } }],
        ports: [
          { protocol: "UDP", port: 53 },
          { protocol: "TCP", port: 53 },
        ],
      },
    ];
    if (opts.poolNamespace) {
      egress.push({
        to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": opts.poolNamespace } } }],
        ports: (opts.storePorts ?? []).map((port) => ({ protocol: "TCP", port })),
      });
    }
    for (const cidr of opts.egressAllowCIDRs ?? []) egress.push({ to: [{ ipBlock: { cidr } }] });
    out.push({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "everdict-zone-egress", namespace },
      spec: { podSelector: {}, policyTypes: ["Egress"], egress },
    });
  }
  return out;
}

// In deny-egress mode, resolve a model endpoint (external, e.g. LiteLLM) into /32 CIDRs that egress is allowed to.
// An IP stays /32; a hostname is resolved to IPs via the injected resolver (default dns) → /32. Automatically merged into egressAllowCIDRs.
function hostOf(endpoint: string): string {
  let h = endpoint.replace(/^[a-z]+:\/\//i, ""); // strip scheme
  h = h.split("/")[0] ?? h; // strip path
  h = h.replace(/:\d+$/, ""); // strip port
  return h;
}
function isIpv4(s: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(s);
}
export async function resolveEgressCidrs(
  endpoints: string[],
  lookup: (host: string) => Promise<string[]>,
): Promise<string[]> {
  const out = new Set<string>();
  for (const ep of endpoints) {
    const host = hostOf(ep);
    if (!host) continue;
    if (isIpv4(host)) {
      out.add(`${host}/32`);
      continue;
    }
    for (const ip of await lookup(host).catch(() => [])) if (isIpv4(ip)) out.add(`${ip}/32`);
  }
  return [...out];
}

// Shared-store ns: allow only ingress from an everdict-managed namespace on the store ports (block reach from outside the platform).
// In pool all tenants share the store, so per-tenant blocking is impossible here — instead block "outside the platform" and do
// per-tenant isolation via DB/role/creds (+ per-case isolateBy) (SLICE 40).
export function buildSharedStoreIngressPolicy(poolNs: string, storePorts: number[]): NetworkPolicyManifest {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "everdict-shared-store-ingress", namespace: poolNs },
    spec: {
      podSelector: {},
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [{ namespaceSelector: { matchLabels: { [MANAGED_LABEL.key]: MANAGED_LABEL.value } } }],
          ports: storePorts.map((port) => ({ protocol: "TCP", port })),
        },
      ],
    },
  };
}
