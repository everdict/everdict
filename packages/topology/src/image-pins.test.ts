import { BadRequestError, type ServiceHarnessSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { applyImagePins } from "./image-pins.js";

const SPEC: ServiceHarnessSpec = {
  kind: "service",
  id: "topo",
  version: "1.0.0",
  services: [
    { name: "agent", image: "reg/agent:1", port: 8000, needs: [], perRun: [], replicas: 1, env: {} },
    { name: "mcp", image: "reg/mcp:1", port: 9000, needs: [], perRun: [], replicas: 1, env: {} },
  ],
  dependencies: [],
  frontDoor: { service: "agent", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://m:5000" },
};

describe("applyImagePins", () => {
  it("returns the spec unchanged (same reference) when there are no pins — no regression", () => {
    expect(applyImagePins(SPEC, undefined)).toBe(SPEC);
    expect(applyImagePins(SPEC, {})).toBe(SPEC);
  });

  it("overrides only the matching service's image and appends a deterministic pin suffix to the version", () => {
    const out = applyImagePins(SPEC, { agent: "reg/agent:2" });
    expect(out.services.find((s) => s.name === "agent")?.image).toBe("reg/agent:2");
    expect(out.services.find((s) => s.name === "mcp")?.image).toBe("reg/mcp:1"); // unpinned service unchanged
    expect(out.version).toMatch(/^1\.0\.0-pin-[0-9a-f]{8}$/);
    expect(SPEC.services[0]?.image).toBe("reg/agent:1"); // original unchanged (pure)
  });

  it("same pins → same version suffix (deterministic), different pins → different suffix → warm pool separation", () => {
    const a1 = applyImagePins(SPEC, { agent: "reg/agent:2" }).version;
    const a2 = applyImagePins(SPEC, { agent: "reg/agent:2" }).version;
    const b = applyImagePins(SPEC, { agent: "reg/agent:3" }).version;
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("same pins in a different key order still yield the same suffix (sort normalization)", () => {
    const x = applyImagePins(SPEC, { agent: "reg/agent:2", mcp: "reg/mcp:2" }).version;
    const y = applyImagePins(SPEC, { mcp: "reg/mcp:2", agent: "reg/agent:2" }).version;
    expect(x).toBe(y);
  });

  it("rejects with BadRequestError when a pin targets a service not in the topology", () => {
    expect(() => applyImagePins(SPEC, { nope: "reg/x:1" })).toThrow(BadRequestError);
  });
});
