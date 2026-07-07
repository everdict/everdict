import type { ServiceHarnessSpec, TrustZone } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { buildSharedStoreIntention, buildTenantIntentions, meshServiceName } from "./consul-intentions.js";

const SPEC: ServiceHarnessSpec = {
  kind: "service",
  id: "bu",
  version: "1.0.0",
  services: [
    { name: "agent-server", image: "a:1", port: 8080, needs: [], perRun: [], replicas: 1, env: {} },
    { name: "browser-mcp", image: "b:1", port: 9000, needs: [], perRun: [], replicas: 1, env: {} },
  ],
  dependencies: [],
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://x" },
};
const zone = (over: Partial<TrustZone>): TrustZone => ({
  id: "acme",
  isolationRuntime: "runc",
  network: "deny-cross-tenant",
  trusted: true,
  ...over,
});

describe("buildTenantIntentions", () => {
  it("per service, an 'allow same-tenant + deny *' intention (deny-by-default per destination)", () => {
    const ints = buildTenantIntentions(SPEC, zone({}));
    expect(ints.map((i) => i.Name).sort()).toEqual(["t-acme-agent-server", "t-acme-browser-mcp"]);
    const agent = ints.find((i) => i.Name === "t-acme-agent-server");
    // both same-tenant services are allowed
    expect(
      agent?.Sources.filter((s) => s.Action === "allow")
        .map((s) => s.Name)
        .sort(),
    ).toEqual(["t-acme-agent-server", "t-acme-browser-mcp"]);
    // everything else (other tenants / non-mesh) is * deny
    expect(agent?.Sources.find((s) => s.Name === "*")?.Action).toBe("deny");
  });

  it("another tenant has a different mesh name so it's not in the allow list (→ hits * deny)", () => {
    const globex = buildTenantIntentions(SPEC, zone({ id: "globex" }));
    const agent = globex.find((i) => i.Name === "t-globex-agent-server");
    expect(agent?.Sources.some((s) => s.Name.startsWith("t-acme-"))).toBe(false);
  });

  it("no intentions when network: open", () => {
    expect(buildTenantIntentions(SPEC, zone({ network: "open" }))).toEqual([]);
  });
});

describe("buildSharedStoreIntention / meshServiceName", () => {
  it("a shared store allows mesh services (*) (tenant isolation = DB creds)", () => {
    const i = buildSharedStoreIntention("postgres");
    expect(i.Name).toBe("everdict-shared-postgres");
    expect(i.Sources).toEqual([{ Name: "*", Action: "allow" }]);
  });
  it("meshServiceName sanitizes the zone", () => {
    expect(meshServiceName("Acme Co", "agent-server")).toMatch(/^t-[a-z0-9_]+-agent-server$/);
  });
});
