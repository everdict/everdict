import type { ServiceHarnessSpec, TrustZone } from "@everdict/core";
import { sanitizeIdent } from "./store-binding.js";

// Nomad 의 네트워크 격리 = Consul Connect intentions(서비스 아이덴티티 기반). K8s NetworkPolicy 의 Nomad 대응.
// 모델: per-destination 자기-deny-default — 목적지 서비스마다 "같은 테넌트 서비스 allow + * deny". Consul 은
// precedence 로 평가(정확한 이름 > '*')하므로 다른 테넌트 서비스는 '*' deny 에 걸려 거부된다(전역 설정 변경 없이
// 목적지별로 deny-by-default 구현). 공유 스토어는 '*' allow(메시 서비스만; 테넌트 격리는 DB creds — pool).
// 주의: enforce 에는 서비스 잡이 Connect-enabled(envoy sidecar + bridge)여야 함(K8s 의 정책-CNI 필요와 동형).
export interface ServiceIntention {
  Kind: "service-intentions";
  Name: string; // 목적지 서비스(mesh 이름)
  Sources: Array<{ Name: string; Action: "allow" | "deny" }>;
}

// 테넌트 서비스의 Connect mesh 이름 — DB 식별자와 같은 규칙으로 sanitize(존 간 충돌 방지).
export function meshServiceName(zoneId: string, svc: string): string {
  return `t-${sanitizeIdent(zoneId)}-${svc}`;
}

// 존(테넌트) intentions: 각 서비스 목적지에 "같은 테넌트 서비스 allow + 그 외 deny".
export function buildTenantIntentions(spec: ServiceHarnessSpec, zone: TrustZone): ServiceIntention[] {
  if (zone.network === "open") return [];
  const sameTenant = spec.services.map((s) => meshServiceName(zone.id, s.name));
  return spec.services.map((s) => ({
    Kind: "service-intentions",
    Name: meshServiceName(zone.id, s.name),
    Sources: [
      ...sameTenant.map((name) => ({ Name: name, Action: "allow" as const })),
      { Name: "*", Action: "deny" as const }, // 다른 테넌트/비메시 → 거부 (precedence 최하)
    ],
  }));
}

// 공유 스토어 intention(pool): 메시 서비스만 도달 허용(테넌트 격리는 DB creds + ACL 이 담당, SLICE 40/42).
export function buildSharedStoreIntention(store: string): ServiceIntention {
  return {
    Kind: "service-intentions",
    Name: `everdict-shared-${store}`,
    Sources: [{ Name: "*", Action: "allow" }],
  };
}

// Consul config-entry 클라이언트(테스트에서 모킹 가능). 기본 impl 은 Consul HTTP API.
export interface ConsulClient {
  applyIntention(entry: ServiceIntention): Promise<void>;
  deleteIntention(name: string): Promise<void>;
}

export function consulHttp(addr: string): ConsulClient {
  const base = addr.replace(/\/$/, "");
  return {
    async applyIntention(entry) {
      const res = await fetch(`${base}/v1/config`, { method: "PUT", body: JSON.stringify(entry) });
      if (!res.ok) throw new Error(`consul config PUT ${entry.Name} failed: ${res.status} ${await res.text()}`);
    },
    async deleteIntention(name) {
      await fetch(`${base}/v1/config/service-intentions/${encodeURIComponent(name)}`, { method: "DELETE" });
    },
  };
}
