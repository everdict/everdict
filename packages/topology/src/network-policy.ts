import type { TrustZone } from "@assay/core";

// K8s NetworkPolicy 로 테넌트(존) 네트워크 격리를 enforce. zone.network 가 정책을 고른다:
//   deny-cross-tenant = 같은 ns 외 ingress 차단(대칭 적용이라 egress 없이도 pod 간 교차 도달 차단) — 안전 기본.
//   deny-egress       = 거기에 더해 egress 를 DNS+같은ns+공유스토어+허용CIDR 로만 제한(데이터 유출 차단).
//   open              = 정책 없음.
// 주의: kubectl port-forward(컨트롤플레인→kubelet→pod)는 CNI pod-network 를 우회하므로 엔드포인트 발견/구동은
//       이 정책에 영향받지 않는다. enforce 에는 정책-CNI(Calico/Cilium)가 필요(kindnet 은 enforce 안 함).
export interface NetworkPolicyManifest {
  apiVersion: "networking.k8s.io/v1";
  kind: "NetworkPolicy";
  metadata: { name: string; namespace: string };
  spec: Record<string, unknown>;
}

// assay 가 만든 네임스페이스 표식 — 공유 스토어 ingress 가 "플랫폼 네임스페이스에서만" 허용할 때 매칭.
export const MANAGED_LABEL = { key: "assay/managed", value: "true" } as const;

export interface ZoneNetworkPolicyOptions {
  namespace: string;
  network: TrustZone["network"];
  poolNamespace?: string; // pool 공유 스토어 ns (deny-egress 일 때 여기로의 egress 허용)
  storePorts?: number[]; // 공유 스토어 포트(예: [5432, 6379])
  dnsNamespace?: string; // 기본 kube-system
  egressAllowCIDRs?: string[]; // 모델 엔드포인트 등 외부 허용 CIDR (deny-egress)
}

export function buildZoneNetworkPolicies(opts: ZoneNetworkPolicyOptions): NetworkPolicyManifest[] {
  const { namespace, network } = opts;
  if (network === "open") return [];
  const out: NetworkPolicyManifest[] = [];

  // ingress: 같은 ns 에서만. 다른 테넌트 ns 가 이 존의 pod 에 연결 개시하는 것을 차단(cross-tenant 차단의 핵심).
  out.push({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "assay-zone-ingress", namespace },
    spec: {
      podSelector: {},
      policyTypes: ["Ingress"],
      ingress: [{ from: [{ podSelector: {} }] }], // podSelector{} (namespaceSelector 없음) = 같은 ns
    },
  });

  if (network === "deny-egress") {
    const dnsNs = opts.dnsNamespace ?? "kube-system";
    const egress: Array<Record<string, unknown>> = [
      { to: [{ podSelector: {} }] }, // 같은 ns
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
      metadata: { name: "assay-zone-egress", namespace },
      spec: { podSelector: {}, policyTypes: ["Egress"], egress },
    });
  }
  return out;
}

// deny-egress 모드에서 모델 엔드포인트(외부, 예: LiteLLM) egress 를 허용할 /32 CIDR 로 해석.
// IP 는 그대로 /32, 호스트명은 주입 resolver(기본 dns)로 IP 들을 찾아 /32. egressAllowCIDRs 에 자동 합쳐진다.
function hostOf(endpoint: string): string {
  let h = endpoint.replace(/^[a-z]+:\/\//i, ""); // scheme 제거
  h = h.split("/")[0] ?? h; // path 제거
  h = h.replace(/:\d+$/, ""); // port 제거
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

// 공유 스토어 ns: assay-managed 네임스페이스에서 스토어 포트로 오는 ingress 만 허용(플랫폼 외부 도달 차단).
// pool 은 모든 테넌트가 스토어를 공유하므로 테넌트별 차단은 불가 — 대신 "플랫폼 밖" 을 막고, 테넌트별 격리는
// DB/role/creds(+케이스 isolateBy)로 한다(SLICE 40).
export function buildSharedStoreIngressPolicy(poolNs: string, storePorts: number[]): NetworkPolicyManifest {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "assay-shared-store-ingress", namespace: poolNs },
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
