import { describe, expect, it } from "vitest";
import { MANAGED_LABEL, buildSharedStoreIngressPolicy, buildZoneNetworkPolicies } from "./network-policy.js";

describe("buildZoneNetworkPolicies", () => {
  it("deny-cross-tenant: 같은-ns ingress 정책만(다른 테넌트 ns 도달 차단)", () => {
    const ps = buildZoneNetworkPolicies({ namespace: "assay-acme", network: "deny-cross-tenant" });
    expect(ps).toHaveLength(1);
    expect(ps[0]?.metadata.name).toBe("assay-zone-ingress");
    expect(ps[0]?.spec.policyTypes).toEqual(["Ingress"]);
    // ingress from 은 같은 ns(podSelector{}, namespaceSelector 없음)
    expect(ps[0]?.spec.ingress).toEqual([{ from: [{ podSelector: {} }] }]);
  });

  it("deny-egress: ingress + egress(DNS/같은ns/공유스토어/허용CIDR)", () => {
    const ps = buildZoneNetworkPolicies({
      namespace: "assay-acme",
      network: "deny-egress",
      poolNamespace: "assay-shared",
      storePorts: [5432, 6379],
      egressAllowCIDRs: ["10.0.0.5/32"],
    });
    expect(ps.map((p) => p.metadata.name)).toEqual(["assay-zone-ingress", "assay-zone-egress"]);
    const egress = ps[1]?.spec.egress as Array<Record<string, unknown>>;
    // DNS 53 허용
    expect(JSON.stringify(egress)).toContain('"port":53');
    // 공유 스토어 ns + 포트
    expect(JSON.stringify(egress)).toContain("assay-shared");
    expect(JSON.stringify(egress)).toContain('"port":5432');
    // 외부 허용 CIDR
    expect(JSON.stringify(egress)).toContain("10.0.0.5/32");
  });

  it("open: 정책 없음", () => {
    expect(buildZoneNetworkPolicies({ namespace: "assay-acme", network: "open" })).toEqual([]);
  });
});

describe("buildSharedStoreIngressPolicy", () => {
  it("assay-managed 네임스페이스에서 스토어 포트로 오는 ingress 만 허용", () => {
    const p = buildSharedStoreIngressPolicy("assay-shared", [5432]);
    expect(p.metadata.namespace).toBe("assay-shared");
    const ingress = p.spec.ingress as Array<{
      from: Array<{ namespaceSelector: { matchLabels: object } }>;
      ports: object[];
    }>;
    expect(ingress[0]?.from[0]?.namespaceSelector.matchLabels).toEqual({ [MANAGED_LABEL.key]: MANAGED_LABEL.value });
    expect(ingress[0]?.ports).toEqual([{ protocol: "TCP", port: 5432 }]);
  });
});
