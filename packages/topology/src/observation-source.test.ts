import type { EnvSnapshot } from "@assay/core";
import { describe, expect, it } from "vitest";
import { observationSourceFor, referenceObservationSource } from "./observation-source.js";

const browserSnap: EnvSnapshot = { kind: "browser", url: "http://x", dom: "<html>", screenshotRef: "s", console: [] };

describe("observation-source (delivery seam)", () => {
  it("reference: 타깃이 있으면 그 스냅샷을 pull 한다(store-fetch)", async () => {
    const target = { snapshot: async () => browserSnap };
    const snap = await referenceObservationSource.observe({ target });
    expect(snap).toEqual(browserSnap);
  });

  it("reference: 타깃이 없으면 prompt 스냅샷(무대 없음 — 1차 신호는 trace)", async () => {
    const snap = await referenceObservationSource.observe({ target: undefined });
    expect(snap).toEqual({ kind: "prompt", output: "" });
  });

  it("observationSourceFor('reference') 는 reference 소스를 돌려준다", () => {
    expect(observationSourceFor("reference")).toBe(referenceObservationSource);
  });

  it("미구현 모드(sentinel/egress)는 명시적으로 throw 한다(침묵 폴백 없음)", () => {
    expect(() => observationSourceFor("sentinel")).toThrow(/sentinel/);
    expect(() => observationSourceFor("egress")).toThrow(/egress/);
  });
});
