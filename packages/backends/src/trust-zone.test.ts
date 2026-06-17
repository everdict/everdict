import { describe, expect, it } from "vitest";
import { perTenantTrustZones, staticTrustZones } from "./trust-zone.js";

describe("perTenantTrustZones", () => {
  it("기본: 테넌트마다 전용 네임스페이스 + 강격리 + untrusted", () => {
    const policy = perTenantTrustZones();
    const z = policy.resolve("acme");
    expect(z.id).toBe("acme");
    expect(z.isolationRuntime).toBe("runsc");
    expect(z.namespace).toBe("assay-acme");
    expect(z.network).toBe("deny-cross-tenant");
    expect(z.trusted).toBe(false);
  });

  it("서로 다른 테넌트는 서로 다른 존/네임스페이스를 받는다 (공유 없음)", () => {
    const policy = perTenantTrustZones();
    expect(policy.resolve("a").namespace).not.toBe(policy.resolve("b").namespace);
  });

  it("overrides 로 first-party(trusted) 테넌트는 격리를 완화할 수 있다", () => {
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
  it("매핑에 없으면 fallback 존으로", () => {
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
