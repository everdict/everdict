import { describe, expect, it } from "vitest";
import { BadRequestError } from "./errors.js";
import { type TrustZone, assertHardenedIsolation, isHardenedRuntime } from "./trust-zone.js";

const zone = (over: Partial<TrustZone>): TrustZone => ({
  id: "t",
  isolationRuntime: "runsc",
  network: "deny-cross-tenant",
  trusted: false,
  ...over,
});

describe("trust zone isolation", () => {
  it("recognizes hardened isolation runtimes", () => {
    expect(isHardenedRuntime("runsc")).toBe(true);
    expect(isHardenedRuntime("kata")).toBe(true);
    expect(isHardenedRuntime("runc")).toBe(false);
    expect(isHardenedRuntime("")).toBe(false);
  });

  it("an untrusted zone requires a hardened isolation runtime (rejects runc/none)", () => {
    expect(() => assertHardenedIsolation(zone({ isolationRuntime: "runc" }))).toThrow(BadRequestError);
    expect(() => assertHardenedIsolation(zone({ isolationRuntime: "" }))).toThrow(BadRequestError);
    expect(() => assertHardenedIsolation(zone({ isolationRuntime: "runsc" }))).not.toThrow();
  });

  it("a trusted (first-party) zone allows runc too", () => {
    expect(() => assertHardenedIsolation(zone({ isolationRuntime: "runc", trusted: true }))).not.toThrow();
  });
});
