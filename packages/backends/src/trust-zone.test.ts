import { describe, expect, it } from "vitest";
import { perTenantTrustZones, staticTrustZones } from "./trust-zone.js";

describe("perTenantTrustZones", () => {
  it("default: each tenant gets a dedicated namespace + strong isolation + untrusted", () => {
    const policy = perTenantTrustZones();
    const z = policy.resolve("acme");
    expect(z.id).toBe("acme");
    expect(z.isolationRuntime).toBe("runsc");
    expect(z.namespace).toBe("everdict-acme");
    expect(z.network).toBe("deny-cross-tenant");
    expect(z.trusted).toBe(false);
  });

  it("different tenants get different zones/namespaces (no sharing)", () => {
    const policy = perTenantTrustZones();
    expect(policy.resolve("a").namespace).not.toBe(policy.resolve("b").namespace);
  });

  it("via overrides, a first-party (trusted) tenant can relax isolation", () => {
    const policy = perTenantTrustZones({
      overrides: {
        internal: { id: "internal", isolationRuntime: "runc", network: "open", trusted: true },
      },
    });
    const z = policy.resolve("internal");
    expect(z.trusted).toBe(true);
    expect(z.isolationRuntime).toBe("runc");
  });
});

describe("staticTrustZones", () => {
  it("falls back to the fallback zone when not in the mapping", () => {
    const fallback = {
      id: "default",
      isolationRuntime: "runsc",
      network: "deny-cross-tenant" as const,
      trusted: false,
    };
    const policy = staticTrustZones({}, fallback);
    expect(policy.resolve("whoever").id).toBe("default");
  });
});
