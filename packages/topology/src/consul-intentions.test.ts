import type { ServiceHarnessSpec, TrustZone } from "@assay/core";
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
  it("서비스마다 '같은 테넌트 allow + * deny' intention(목적지별 deny-by-default)", () => {
    const ints = buildTenantIntentions(SPEC, zone({}));
    expect(ints.map((i) => i.Name).sort()).toEqual(["t-acme-agent-server", "t-acme-browser-mcp"]);
    const agent = ints.find((i) => i.Name === "t-acme-agent-server");
    // 같은 테넌트 두 서비스는 allow
    expect(
      agent?.Sources.filter((s) => s.Action === "allow")
        .map((s) => s.Name)
        .sort(),
    ).toEqual(["t-acme-agent-server", "t-acme-browser-mcp"]);
    // 그 외(다른 테넌트/비메시)는 * deny
    expect(agent?.Sources.find((s) => s.Name === "*")?.Action).toBe("deny");
  });

  it("다른 테넌트는 메시 이름이 달라 allow 목록에 없다(→ * deny 에 걸림)", () => {
    const globex = buildTenantIntentions(SPEC, zone({ id: "globex" }));
    const agent = globex.find((i) => i.Name === "t-globex-agent-server");
    expect(agent?.Sources.some((s) => s.Name.startsWith("t-acme-"))).toBe(false);
  });

  it("network: open 이면 intention 없음", () => {
    expect(buildTenantIntentions(SPEC, zone({ network: "open" }))).toEqual([]);
  });
});

describe("buildSharedStoreIntention / meshServiceName", () => {
  it("공유 스토어는 메시 서비스(*) allow(테넌트 격리는 DB creds)", () => {
    const i = buildSharedStoreIntention("postgres");
    expect(i.Name).toBe("assay-shared-postgres");
    expect(i.Sources).toEqual([{ Name: "*", Action: "allow" }]);
  });
  it("meshServiceName 은 zone 을 sanitize 한다", () => {
    expect(meshServiceName("Acme Co", "agent-server")).toMatch(/^t-[a-z0-9_]+-agent-server$/);
  });
});
