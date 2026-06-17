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
  it("강격리 런타임을 인식한다", () => {
    expect(isHardenedRuntime("runsc")).toBe(true);
    expect(isHardenedRuntime("kata")).toBe(true);
    expect(isHardenedRuntime("runc")).toBe(false);
    expect(isHardenedRuntime("")).toBe(false);
  });

  it("untrusted 존은 강격리 런타임을 강제한다 (runc/none 거부)", () => {
    expect(() => assertHardenedIsolation(zone({ isolationRuntime: "runc" }))).toThrow(BadRequestError);
    expect(() => assertHardenedIsolation(zone({ isolationRuntime: "" }))).toThrow(BadRequestError);
    expect(() => assertHardenedIsolation(zone({ isolationRuntime: "runsc" }))).not.toThrow();
  });

  it("trusted(first-party) 존은 runc 도 허용한다", () => {
    expect(() => assertHardenedIsolation(zone({ isolationRuntime: "runc", trusted: true }))).not.toThrow();
  });
});
