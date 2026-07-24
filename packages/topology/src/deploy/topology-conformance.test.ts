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

// Store-side conformance: a redis dependency with inject (BYO env names) rendered from the SAME storeValues must land
// identically on both builders, and must OVERRIDE a stale service.env literal (the exact rupture inject exists to
// close: an image reading VALKEY_URL used to see only the literal, never the deployed store).
const storeCanary: ServiceHarnessSpec = {
  kind: "service",
  id: "spica",
  version: "1",
  services: [svc({ name: "app", port: 8080, env: { VALKEY_URL: "redis://stale-literal:6379" } })],
  dependencies: [
    {
      store: "redis",
      role: "queue",
      purpose: "plumbing",
      isolateBy: "key-prefix",
      inject: [{ env: "VALKEY_URL", template: "valkey://{userinfo}{host}:{port}" }],
    },
  ],
  frontDoor: { service: "app", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://otel:4318" },
};

const mintedRedis = {
  host: "everdict-shared-redis",
  port: "6379",
  endpoint: "everdict-shared-redis:6379",
  url: "redis://acme:pw@everdict-shared-redis:6379",
  user: "acme",
  password: "pw",
  userinfo: "acme:pw@",
  keyPrefix: "t:acme:",
};

describe("cross-runtime conformance — dependency inject renders identically and beats the stale literal", () => {
  function nomadAppEnv(): Record<string, string> {
    const groups = (buildNomadTopologyJob(storeCanary, { storeValues: { redis: mintedRedis } }) as NomadJob).Job
      .TaskGroups;
    const env = groups.find((g) => g.Name === SERVICE_GROUP_NAME)?.Tasks.find((t) => t.Name === "app")?.Env;
    if (!env) throw new Error("no nomad task env for app");
    return env;
  }
  function k8sAppEnv(): Record<string, string> {
    const dep = buildK8sManifests(storeCanary, { storeValues: { redis: mintedRedis } }).find(
      (m) => m.kind === "Deployment" && m.metadata.name === "spica-app",
    );
    if (!dep) throw new Error("no k8s deployment spica-app");
    const container = (dep.spec as K8sDeploySpec).template.spec.containers[0];
    return Object.fromEntries((container?.env ?? []).map((e) => [e.name, e.value]));
  }

  it("Nomad renders the BYO env name from the deployed store's coordinates, over the service.env literal", () => {
    expect(nomadAppEnv().VALKEY_URL).toBe("valkey://acme:pw@everdict-shared-redis:6379");
  });

  it("K8s renders the SAME value from the SAME storeValues — one mapping, every runtime", () => {
    expect(k8sAppEnv().VALKEY_URL).toBe(nomadAppEnv().VALKEY_URL);
  });
});

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

// gap 5: host.docker.internal (a service reaching a host-local gateway, e.g. a LiteLLM proxy) is a Docker-CLI idiom.
// Its target is configurable per runtime so a Nomad docker driver that doesn't translate the `host-gateway` keyword —
// and K8s, which has no docker host at all — can be given a concrete gateway IP for parity with the Docker path.
describe("cross-runtime conformance — host.docker.internal gateway is configurable per runtime (gap 5)", () => {
  type NomadTaskConfig = { Name: string; Config?: { extra_hosts?: string[] } };
  type NomadJobConfig = { Job: { TaskGroups: Array<{ Name: string; Tasks: NomadTaskConfig[] }> } };
  const nomadExtraHosts = (opts: Parameters<typeof buildNomadTopologyJob>[1]): string[] => {
    const groups = (buildNomadTopologyJob(canary, opts) as NomadJobConfig).Job.TaskGroups;
    return (
      groups.find((g) => g.Name === SERVICE_GROUP_NAME)?.Tasks.find((t) => t.Name === "web")?.Config?.extra_hosts ?? []
    );
  };
  type K8sPodSpec = { template: { spec: { hostAliases?: Array<{ ip: string; hostnames: string[] }> } } };
  const k8sHostAliases = (
    opts: Parameters<typeof buildK8sManifests>[1],
  ): K8sPodSpec["template"]["spec"]["hostAliases"] => {
    const dep = buildK8sManifests(canary, opts).find(
      (m) => m.kind === "Deployment" && m.metadata.name === "canary-web",
    );
    return (dep?.spec as K8sPodSpec | undefined)?.template.spec.hostAliases;
  };

  it("Nomad defaults host.docker.internal to the host-gateway keyword and takes a concrete IP override", () => {
    expect(nomadExtraHosts({})).toContain("host.docker.internal:host-gateway");
    expect(nomadExtraHosts({ hostGatewayAddr: "172.17.0.1" })).toContain("host.docker.internal:172.17.0.1");
  });

  it("K8s adds no hostAlias by default (no docker host), and one when a concrete IP is configured", () => {
    expect(k8sHostAliases({})).toBeUndefined();
    expect(k8sHostAliases({ hostGatewayAddr: "172.17.0.1" })).toEqual([
      { ip: "172.17.0.1", hostnames: ["host.docker.internal"] },
    ]);
    // the Docker-only "host-gateway" keyword is not a valid K8s hostAlias IP → skipped.
    expect(k8sHostAliases({ hostGatewayAddr: "host-gateway" })).toBeUndefined();
  });
});
