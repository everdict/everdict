import { describe, expect, it } from "vitest";
import {
  MANAGED_LABEL,
  buildSharedStoreIngressPolicy,
  buildZoneNetworkPolicies,
  resolveEgressCidrs,
} from "./network-policy.js";

describe("buildZoneNetworkPolicies", () => {
  it("deny-cross-tenant: same-ns ingress policy only (blocks reach from other tenant ns)", () => {
    const ps = buildZoneNetworkPolicies({ namespace: "everdict-acme", network: "deny-cross-tenant" });
    expect(ps).toHaveLength(1);
    expect(ps[0]?.metadata.name).toBe("everdict-zone-ingress");
    expect(ps[0]?.spec.policyTypes).toEqual(["Ingress"]);
    // ingress from is the same ns (podSelector{}, no namespaceSelector)
    expect(ps[0]?.spec.ingress).toEqual([{ from: [{ podSelector: {} }] }]);
  });

  it("deny-egress: ingress + egress (DNS / same-ns / shared store / allowed CIDR)", () => {
    const ps = buildZoneNetworkPolicies({
      namespace: "everdict-acme",
      network: "deny-egress",
      poolNamespace: "everdict-shared",
      storePorts: [5432, 6379],
      egressAllowCIDRs: ["10.0.0.5/32"],
    });
    expect(ps.map((p) => p.metadata.name)).toEqual(["everdict-zone-ingress", "everdict-zone-egress"]);
    const egress = ps[1]?.spec.egress as Array<Record<string, unknown>>;
    // DNS 53 allowed
    expect(JSON.stringify(egress)).toContain('"port":53');
    // shared store ns + port
    expect(JSON.stringify(egress)).toContain("everdict-shared");
    expect(JSON.stringify(egress)).toContain('"port":5432');
    // external allowed CIDR
    expect(JSON.stringify(egress)).toContain("10.0.0.5/32");
  });

  it("open: no policy", () => {
    expect(buildZoneNetworkPolicies({ namespace: "everdict-acme", network: "open" })).toEqual([]);
  });
});

describe("resolveEgressCidrs (deny-egress model-endpoint CIDR automation)", () => {
  it("hosts are DNS-resolved to /32, IPs stay /32 (scheme/port/path ignored, deduplicated)", async () => {
    const lookup = async (h: string) => ({ litellm: ["172.17.0.1"], "api.x.com": ["1.2.3.4", "1.2.3.5"] })[h] ?? [];
    const cidrs = await resolveEgressCidrs(
      ["http://litellm:4000", "10.0.0.5", "https://api.x.com:443/v1", "http://litellm:4000"],
      lookup,
    );
    expect(cidrs.sort()).toEqual(["1.2.3.4/32", "1.2.3.5/32", "10.0.0.5/32", "172.17.0.1/32"]);
  });
  it("skips hosts that fail to resolve (empty result)", async () => {
    expect(await resolveEgressCidrs(["nope.invalid"], async () => [])).toEqual([]);
  });
});

describe("buildSharedStoreIngressPolicy", () => {
  it("allows ingress on the store port only from an everdict-managed namespace", () => {
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
