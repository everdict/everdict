import { describe, expect, it, vi } from "vitest";
import { buildTrustZones } from "./trust-zones.js";

// The isolation mode is a DEPLOYMENT decision with a prerequisite (a hardened runtime + namespaces), so the
// composition never guesses it — and never leaves the operator guessing either.
describe("buildTrustZones — the operator says how tenants are isolated, and boot says it back", () => {
  const quiet = () => vi.spyOn(console, "log").mockImplementation(() => {});

  it("defaults to runtime-declared: no policy, and the banner says the RuntimeSpec decides", () => {
    const log = quiet();
    const { mode, trustZones } = buildTrustZones({});
    expect(mode).toBe("runtime-declared");
    expect(trustZones).toBeUndefined(); // absent, so the backends keep the spec's own runtime/namespace
    expect(log.mock.calls[0]?.[0]).toContain("runtime-declared");
    log.mockRestore();
  });

  it("per-tenant builds a zone per tenant, honoring the operator's runtime and namespace prefix", () => {
    const log = quiet();
    const { mode, trustZones } = buildTrustZones({
      EVERDICT_TRUST_ZONES: "per-tenant",
      EVERDICT_TRUST_ZONE_RUNTIME: "kata",
      EVERDICT_TRUST_ZONE_NAMESPACE_PREFIX: "zone-",
    });
    expect(mode).toBe("per-tenant");
    expect(trustZones?.resolve("acme")).toMatchObject({
      id: "acme",
      isolationRuntime: "kata",
      namespace: "zone-acme",
      trusted: false,
    });
    expect(log.mock.calls[0]?.[0]).toContain("kata");
    log.mockRestore();
  });

  it("REFUSES to boot on an unrecognized mode — an isolation setting nobody honors is worse than one that fails loudly", () => {
    expect(() => buildTrustZones({ EVERDICT_TRUST_ZONES: "strict" })).toThrow(/not a trust-zone mode/);
    // A typo must never silently degrade to the permissive default.
    expect(() => buildTrustZones({ EVERDICT_TRUST_ZONES: "pertenant" })).toThrow();
  });
});
