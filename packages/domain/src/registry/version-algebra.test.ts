import { describe, expect, it } from "vitest";
import { compareVersions, resolveRef, sortVersions } from "./version-algebra.js";

describe("version algebra — semver ordering + latest resolution", () => {
  it("orders semver versions numerically, not lexically", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0); // 2 < 10 numerically (lexical would say otherwise)
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(sortVersions(["1.10.0", "1.2.0", "1.0.0"])).toEqual(["1.0.0", "1.2.0", "1.10.0"]);
  });

  it("resolveRef(latest) returns the highest semver version; a concrete ref returns itself", () => {
    expect(resolveRef("h", "latest", ["1.0.0", "1.2.0", "1.10.0"])).toBe("1.10.0");
    expect(resolveRef("h", "1.2.0", ["1.0.0", "1.2.0", "1.10.0"])).toBe("1.2.0");
  });

  it("resolveRef throws NOT_FOUND for an unknown version or an empty registry", () => {
    expect(() => resolveRef("h", "9.9.9", ["1.0.0"])).toThrow(/not found/i);
    expect(() => resolveRef("h", "latest", [])).toThrow(/not found/i);
  });

  // Invariant pin: an empty/non-semver version compares EQUAL to everything (returns 0). That is exactly why a bare
  // version string is dangerous — an empty version tie-breaks by registration order and, if registered last, tail-sorts
  // to `latest`. The fix rejects empty at the boundary (contracts VersionSchema) + in VersionedStore.register; this test
  // pins the algebra behavior so a future compareVersions change can't silently reintroduce the latest-pollution.
  it("treats an empty/non-semver version as unordered (0) — why the boundary must reject empty", () => {
    expect(compareVersions("", "1.0.0")).toBe(0);
    expect(compareVersions("nonsense", "1.0.0")).toBe(0);
    // Free-string versions with no semver compare equal → their relative order is registration order (seq tie-break in
    // the store), which is the intended behavior for non-semver — but an EMPTY string must never enter (boundary-rejected).
    expect(compareVersions("v1", "v2")).toBe(0);
  });
});
