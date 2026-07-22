import { describe, expect, it } from "vitest";
import { clampFidelity, FIDELITY_ORDER } from "./fidelity.js";

describe("clampFidelity", () => {
  it("returns the requested rung when the recorder supports it", () => {
    // Given a request at or below the recorder's ceiling
    expect(clampFidelity("frames", "semantic")).toBe("frames");
    expect(clampFidelity("final", "final")).toBe("final");
    expect(clampFidelity("off", "full")).toBe("off");
  });

  it("clamps a request above the recorder's ceiling down to the ceiling (no silent phantom capture)", () => {
    // e.g. a `semantic` request on an os-use recorder that maxes at `frames`
    expect(clampFidelity("semantic", "frames")).toBe("frames");
    expect(clampFidelity("full", "final")).toBe("final");
    expect(clampFidelity("frames", "off")).toBe("off");
  });

  it("orders the ladder ascending by capture depth", () => {
    expect(FIDELITY_ORDER).toEqual(["off", "final", "frames", "semantic", "full"]);
  });
});
