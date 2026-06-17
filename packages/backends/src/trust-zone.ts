import { type TrustZone, TrustZoneSchema } from "@assay/core";

// tenant → TrustZone 해석. 컨트롤플레인이 백엔드/토폴로지에 주입한다.
export interface TrustZonePolicy {
  resolve(tenant: string): TrustZone;
}

export interface PerTenantTrustZoneOptions {
  isolationRuntime?: string; // 기본 강격리 런타임 (기본 "runsc")
  namespacePrefix?: string; // 기본 "assay-" → 네임스페이스 = assay-<tenant>
  network?: TrustZone["network"]; // 기본 deny-cross-tenant
  overrides?: Record<string, TrustZone>; // 특정 테넌트 명시 존(예: first-party trusted = runc 공유 허용)
}

// 안전 기본값: 테넌트마다 자기 존(강격리 runsc + 전용 네임스페이스 + cross-tenant 차단, untrusted).
// → 임의 코드 실행을 테넌트 경계 안에 가둔다. overrides 로 first-party(trusted)만 완화.
export function perTenantTrustZones(opts: PerTenantTrustZoneOptions = {}): TrustZonePolicy {
  const isolationRuntime = opts.isolationRuntime ?? "runsc";
  const prefix = opts.namespacePrefix ?? "assay-";
  const network = opts.network ?? "deny-cross-tenant";
  return {
    resolve(tenant) {
      const override = opts.overrides?.[tenant];
      if (override) return TrustZoneSchema.parse(override);
      return TrustZoneSchema.parse({
        id: tenant,
        isolationRuntime,
        namespace: `${prefix}${tenant}`,
        network,
        trusted: false,
      });
    },
  };
}

// 고정 매핑(테넌트→존). 미등록 테넌트는 default 존으로.
export function staticTrustZones(zones: Record<string, TrustZone>, fallback: TrustZone): TrustZonePolicy {
  return {
    resolve(tenant) {
      return TrustZoneSchema.parse(zones[tenant] ?? fallback);
    },
  };
}
