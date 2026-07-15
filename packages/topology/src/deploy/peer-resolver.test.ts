import type { TopologyService } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { staticWiringEnv } from "./nomad-topology.js";
import { aliasPeerHost, k8sPeerHost } from "./peer-resolver.js";

const svc = (over: Partial<TopologyService> & { name: string }): TopologyService => ({
  image: "img:1",
  needs: [],
  perRun: [],
  replicas: 1,
  env: {},
  ...over,
});

describe("peer resolvers — the cross-runtime peer-host divergence is locked", () => {
  const planner = svc({ name: "planner", port: 8000 });

  it("docker / co-located Nomad address a peer by its plain service name", () => {
    expect(aliasPeerHost(planner)).toBe("planner");
  });

  it("K8s addresses a peer by its <harnessId>-<service> Service DNS name (why a literal <svc> breaks on K8s)", () => {
    expect(k8sPeerHost("bu")(planner)).toBe("bu-planner");
  });

  it("the SAME wiring spec resolves to each backend's correct peer URL through one seam (staticWiringEnv)", () => {
    const web = svc({ name: "web", port: 8080, wiring: [{ service: "planner", urlEnv: "PLANNER_URL" }] });
    const services = [web, planner];
    // Docker / co-located Nomad → plain alias; K8s → Service DNS. Same input, one seam, two correct forms.
    expect(staticWiringEnv(web, services, aliasPeerHost).PLANNER_URL).toBe("http://planner:8000");
    expect(staticWiringEnv(web, services, k8sPeerHost("bu")).PLANNER_URL).toBe("http://bu-planner:8000");
  });
});
