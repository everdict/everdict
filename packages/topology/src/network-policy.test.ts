import { describe, expect, it } from "vitest";
import {
  MANAGED_LABEL,
  buildSharedStoreIngressPolicy,
  buildZoneNetworkPolicies,
  resolveEgressCidrs,
} from "./network-policy.js";

describe("buildZoneNetworkPolicies", () => {
  it("deny-cross-tenant: 같은-ns ingress 정책만(다른 테넌트 ns 도달 차단)", () => {
    const ps = buildZoneNetworkPolicies({ namespace: "everdict-acme", network: "deny-cross-tenant" });
    expect(ps).toHaveLength(1);
    expect(ps[0]?.metadata.name).toBe("everdict-zone-ingress");
    expect(ps[0]?.spec.policyTypes).toEqual(["Ingress"]);
    // ingress from 은 같은 ns(podSelector{}, namespaceSelector 없음)
    expect(ps[0]?.spec.ingress).toEqual([{ from: [{ podSelector: {} }] }]);
  });

  it("deny-egress: ingress + egress(DNS/같은ns/공유스토어/허용CIDR)", () => {
    const ps = buildZoneNetworkPolicies({
      namespace: "everdict-acme",
      network: "deny-egress",
      poolNamespace: "everdict-shared",
      storePorts: [5432, 6379],
      egressAllowCIDRs: ["10.0.0.5/32"],
    });
    expect(ps.map((p) => p.metadata.name)).toEqual(["everdict-zone-ingress", "everdict-zone-egress"]);
    const egress = ps[1]?.spec.egress as Array<Record<string, unknown>>;
    // DNS 53 허용
    expect(JSON.stringify(egress)).toContain('"port":53');
    // 공유 스토어 ns + 포트
    expect(JSON.stringify(egress)).toContain("everdict-shared");
    expect(JSON.stringify(egress)).toContain('"port":5432');
    // 외부 허용 CIDR
    expect(JSON.stringify(egress)).toContain("10.0.0.5/32");
  });

  it("open: 정책 없음", () => {
    expect(buildZoneNetworkPolicies({ namespace: "everdict-acme", network: "open" })).toEqual([]);
  });
});

describe("resolveEgressCidrs (deny-egress 모델 엔드포인트 CIDR 자동화)", () => {
  it("호스트는 DNS 해석해 /32, IP 는 그대로 /32 (scheme/포트/path 무시, 중복제거)", async () => {
    const lookup = async (h: string) => ({ litellm: ["172.17.0.1"], "api.x.com": ["1.2.3.4", "1.2.3.5"] })[h] ?? [];
    const cidrs = await resolveEgressCidrs(
      ["http://litellm:4000", "10.0.0.5", "https://api.x.com:443/v1", "http://litellm:4000"],
      lookup,
    );
    expect(cidrs.sort()).toEqual(["1.2.3.4/32", "1.2.3.5/32", "10.0.0.5/32", "172.17.0.1/32"]);
  });
  it("해석 실패 호스트는 건너뛴다(빈 결과)", async () => {
    expect(await resolveEgressCidrs(["nope.invalid"], async () => [])).toEqual([]);
  });
});

describe("buildSharedStoreIngressPolicy", () => {
  it("everdict-managed 네임스페이스에서 스토어 포트로 오는 ingress 만 허용", () => {
    const p = buildSharedStoreIngressPolicy("everdict-shared", [5432]);
    expect(p.metadata.namespace).toBe("everdict-shared");
    const ingress = p.spec.ingress as Array<{
      from: Array<{ namespaceSelector: { matchLabels: object } }>;
      ports: object[];
    }>;
    expect(ingress[0]?.from[0]?.namespaceSelector.matchLabels).toEqual({ [MANAGED_LABEL.key]: MANAGED_LABEL.value });
    expect(ingress[0]?.ports).toEqual([{ protocol: "TCP", port: 5432 }]);
  });
});
