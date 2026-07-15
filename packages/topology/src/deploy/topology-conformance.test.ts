import type { ServiceHarnessSpec, TopologyService } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { buildK8sManifests } from "./k8s-topology.js";
import { SERVICE_GROUP_NAME, buildNomadTopologyJob } from "./nomad-topology.js";

// Cross-runtime conformance (L3, deterministic slice) — ONE canary spec, run through the pure builders, must wire the
// SAME logical peer to EACH backend's correct physical host: Nomad co-located = the plain alias (loopback via
// extra_hosts), K8s = the `<id>-<service>` Service DNS. Addressing the peer two portable ways (a wiring urlEnv + a
// {{peer}} env token) proves both paths honor the divergence. This locks "one HarnessSpec, correct on every runtime"
// at the builder level (the live 3-backend proof is the env-gated scenario follow-up). docs/architecture/topology-portability.md.

const svc = (over: Partial<TopologyService> & { name: string }): TopologyService => ({
  image: "img:1",
  needs: [],
  perRun: [],
  replicas: 1,
  env: {},
  ...over,
});

const canary: ServiceHarnessSpec = {
  kind: "service",
  id: "canary",
  version: "1",
  services: [
    svc({
      name: "web",
      port: 8080,
      needs: ["planner"],
      wiring: [{ service: "planner", urlEnv: "PLANNER_URL" }],
      env: { API: "http://{{planner.host}}:{{planner.port}}/v1" },
    }),
    svc({ name: "planner", port: 8000 }),
  ],
  dependencies: [],
  frontDoor: { service: "web", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://otel:4318" },
};

type NomadTask = { Name: string; Env?: Record<string, string> };
type NomadGroup = { Name: string; Tasks: NomadTask[] };
type NomadJob = { Job: { TaskGroups: NomadGroup[] } };
function nomadServiceEnv(name: string): Record<string, string> {
  const groups = (buildNomadTopologyJob(canary) as NomadJob).Job.TaskGroups;
  const env = groups.find((g) => g.Name === SERVICE_GROUP_NAME)?.Tasks.find((t) => t.Name === name)?.Env;
  if (!env) throw new Error(`no nomad task env for ${name}`);
  return env;
}

type K8sEnvVar = { name: string; value: string };
type K8sDeploySpec = { template: { spec: { containers: Array<{ env?: K8sEnvVar[] }> } } };
function k8sServiceEnv(deployName: string): Record<string, string> {
  const dep = buildK8sManifests(canary).find((m) => m.kind === "Deployment" && m.metadata.name === deployName);
  if (!dep) throw new Error(`no k8s deployment ${deployName}`);
  const container = (dep.spec as K8sDeploySpec).template.spec.containers[0];
  return Object.fromEntries((container?.env ?? []).map((e) => [e.name, e.value]));
}

describe("cross-runtime conformance — one canary, each backend's correct peer address", () => {
  it("Nomad (co-located) addresses the peer by its plain alias — via wiring AND {{peer}}", () => {
    const env = nomadServiceEnv("web");
    expect(env.PLANNER_URL).toBe("http://planner:8000");
    expect(env.API).toBe("http://planner:8000/v1");
  });

  it("K8s addresses the same peer by its <id>-<service> Service DNS — via wiring AND {{peer}}", () => {
    const env = k8sServiceEnv("canary-web");
    expect(env.PLANNER_URL).toBe("http://canary-planner:8000");
    expect(env.API).toBe("http://canary-planner:8000/v1");
  });

  it("the divergence is real: the SAME spec yields different-but-correct hosts per backend", () => {
    expect(nomadServiceEnv("web").PLANNER_URL).not.toBe(k8sServiceEnv("canary-web").PLANNER_URL);
  });
});
