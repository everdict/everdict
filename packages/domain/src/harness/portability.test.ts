import { BadRequestError, type ServiceHarnessSpec, type TopologyService } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type PortabilityRule, assertPortable, checkPortability } from "./portability.js";

const svc = (over: Partial<TopologyService> & { name: string }): TopologyService => ({
  image: "img:1",
  needs: [],
  perRun: [],
  replicas: 1,
  env: {},
  ...over,
});

const spec = (services: TopologyService[], over: Partial<ServiceHarnessSpec> = {}): ServiceHarnessSpec => ({
  kind: "service",
  id: "h",
  version: "1",
  services,
  dependencies: [],
  frontDoor: { service: services[0]?.name ?? "web", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://otel.example.com" },
  ...over,
});

const rules = (spc: ServiceHarnessSpec): PortabilityRule[] => checkPortability(spc).map((i) => i.rule);

describe("checkPortability", () => {
  it("a spec that addresses peers only via {{peer}} with matching needs+port is portable (no issues)", () => {
    const s = spec([
      svc({ name: "web", port: 3000, needs: ["api"], env: { API_URL: "http://{{api}}/v1" } }),
      svc({ name: "api", port: 4000 }),
    ]);
    expect(checkPortability(s)).toEqual([]);
  });

  it("flags a literal localhost host in a service env value", () => {
    const s = spec([svc({ name: "web", port: 3000, env: { API_URL: "http://localhost:4000" } })]);
    expect(rules(s)).toContain("no-literal-host");
  });

  it("flags a hardcoded private IP host", () => {
    const s = spec([svc({ name: "web", port: 3000, env: { API_URL: "http://10.0.0.5:4000" } })]);
    expect(rules(s)).toContain("no-literal-host");
  });

  it("flags a peer addressed by its literal service name (should be {{peer}})", () => {
    const s = spec([
      svc({ name: "web", port: 3000, needs: ["api"], env: { API_URL: "http://api:4000" } }),
      svc({ name: "api", port: 4000 }),
    ]);
    expect(rules(s)).toContain("peer-by-literal");
  });

  it("flags a {{peer}} reference not declared in needs (works on Docker, fails on per-service Nomad)", () => {
    const s = spec([
      svc({ name: "web", port: 3000, needs: [], env: { API_URL: "http://{{api}}" } }),
      svc({ name: "api", port: 4000 }),
    ]);
    expect(rules(s)).toContain("needs-complete");
  });

  it("flags a referenced peer that exposes no port", () => {
    const s = spec([
      svc({ name: "web", port: 3000, needs: ["api"], env: { API_URL: "http://{{api}}" } }),
      svc({ name: "api" }), // no port
    ]);
    expect(rules(s)).toContain("addressed-has-port");
  });

  it("flags a front door that references an undeclared service", () => {
    const s = spec([svc({ name: "web", port: 3000 })], { frontDoor: { service: "gateway", submit: "POST /runs" } });
    expect(rules(s)).toContain("reference-not-address");
  });

  it("flags two services sharing a port (co-located netns forbids it)", () => {
    const s = spec([svc({ name: "web", port: 3000 }), svc({ name: "api", port: 3000 })]);
    expect(rules(s)).toContain("unique-ports");
  });

  it("scans the front-door bodyTemplate for a literal host", () => {
    const s = spec([svc({ name: "web", port: 3000 })], {
      frontDoor: { service: "web", submit: "POST /runs", request: { bodyTemplate: { base: "http://127.0.0.1:8000" } } },
    });
    expect(rules(s)).toContain("no-literal-host");
  });

  it("does not scan a { secretRef } env value (no authored address there)", () => {
    const s = spec([svc({ name: "web", port: 3000, env: { TOKEN: { secretRef: "api-key" } } })]);
    expect(checkPortability(s)).toEqual([]);
  });

  it("flags a peer addressed by literal name via the wiring[] BYO env injection without a needs edge", () => {
    const s = spec([
      svc({ name: "web", port: 3000, needs: [], wiring: [{ service: "bus", hostEnv: "SE_EVENT_BUS_HOST" }] }),
      svc({ name: "bus", port: 5557 }),
    ]);
    expect(rules(s)).toContain("needs-complete");
  });

  it("classifies a structural violation as error and a host literal as warning", () => {
    const structural = spec([
      svc({ name: "web", port: 3000, needs: [], env: { API_URL: "http://{{api}}" } }),
      svc({ name: "api", port: 4000 }),
    ]);
    expect(checkPortability(structural).find((i) => i.rule === "needs-complete")?.severity).toBe("error");

    const hostLiteral = spec([svc({ name: "web", port: 3000, env: { API_URL: "http://localhost:4000" } })]);
    expect(checkPortability(hostLiteral).find((i) => i.rule === "no-literal-host")?.severity).toBe("warning");
  });
});

describe("assertPortable", () => {
  it("throws on a structural error (a peer addressed by its literal name)", () => {
    const s = spec([
      svc({ name: "web", port: 3000, needs: ["api"], env: { API_URL: "http://api:4000" } }),
      svc({ name: "api", port: 4000 }),
    ]);
    expect(() => assertPortable(s)).toThrow(BadRequestError);
  });

  it("does NOT throw on a host-literal-only spec (a warning is surfaced, not blocked)", () => {
    const s = spec([svc({ name: "web", port: 3000, env: { API_URL: "http://localhost:4000" } })]);
    expect(() => assertPortable(s)).not.toThrow();
  });

  it("does not touch a non-service spec", () => {
    expect(() => assertPortable({ kind: "process", id: "cc", version: "1" })).not.toThrow();
  });
});
