import type { ServiceHarnessSpec, TrustZone } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_IMAGE } from "./deploy/browser-image.js";
import { K8sTopologyRuntime } from "./deploy/k8s-runtime.js";
import {
  REGISTRY_AUTH_SECRET_NAME,
  browserDeployName,
  buildBrowserManifests,
  buildK8sManifests,
  namespaceManifest,
} from "./deploy/k8s-topology.js";
import type { Kubectl, PortForward } from "./deploy/kubectl.js";

const SPEC: ServiceHarnessSpec = {
  kind: "service",
  id: "bu",
  version: "1.0.0",
  services: [{ name: "agent-server", image: "reg/echo:1", port: 8080, needs: [], perRun: [], replicas: 1, env: {} }],
  dependencies: [],
  target: { kind: "browser", engine: "chromium", lifecycle: "per-case-instance", observe: ["url"] },
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://mlflow:5000" },
};

// A fake kubectl that records calls; port-forward returns a fixed local port.
function fakeKubectl(execOut = ""): { kubectl: Kubectl; calls: string[]; applied: Array<Record<string, unknown>> } {
  const calls: string[] = [];
  const applied: Array<Record<string, unknown>> = [];
  let port = 40000;
  const kubectl: Kubectl = {
    async apply(manifests) {
      for (const m of manifests) applied.push(m as Record<string, unknown>);
      calls.push(`apply:${manifests.map((m) => `${(m as { kind: string }).kind}`).join(",")}`);
    },
    async ensureNamespace(ns) {
      calls.push(`ns:${ns}`);
    },
    async rolloutStatus(deploy, ns) {
      calls.push(`rollout:${ns}/${deploy}`);
    },
    async portForward(target, ns): Promise<PortForward> {
      calls.push(`pf:${ns}/${target}`);
      return { localPort: port++, async stop() {} };
    },
    async deleteResources(targets, ns) {
      calls.push(`del:${ns}/${targets.join("+")}`);
    },
    async deleteNamespace(ns) {
      calls.push(`delns:${ns}`);
    },
    async podFor(selector, ns) {
      calls.push(`podFor:${ns}/${selector}`);
      return `${selector.replace(/^app=/, "")}-pod`;
    },
    async exec(pod, ns, command, stdin) {
      calls.push(`exec:${ns}/${pod}:${command.join(" ")}${stdin ? ":stdin" : ""}`);
      return execOut;
    },
  };
  return { kubectl, calls, applied };
}

const okFetch = (async () =>
  new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://x" }))) as unknown as typeof fetch;

const ZONE = (id: string): TrustZone => ({
  id,
  isolationRuntime: "runsc",
  namespace: `everdict-${id}`,
  network: "deny-cross-tenant",
  trusted: false,
});

describe("buildK8sManifests — workspace-registry pull auth (registryAuth)", () => {
  const AUTH = { host: "ghcr.io", username: "bot", password: "pull-tok" };
  const withImage = (image: string): ServiceHarnessSpec => ({
    ...SPEC,
    services: SPEC.services.map((s) => ({ ...s, image })),
  });

  it("renders a dockerconfigjson Secret + imagePullSecrets when the service image host matches", () => {
    const manifests = buildK8sManifests(withImage("ghcr.io/acme/agent:v1"), { registryAuth: AUTH });
    const secret = manifests.find((m) => m.kind === "Secret") as unknown as {
      metadata: { name: string };
      type: string;
      data: Record<string, string>;
    };
    expect(secret.metadata.name).toBe(REGISTRY_AUTH_SECRET_NAME);
    expect(secret.type).toBe("kubernetes.io/dockerconfigjson");
    const config = JSON.parse(Buffer.from(secret.data[".dockerconfigjson"] ?? "", "base64").toString());
    expect(Buffer.from(config.auths["ghcr.io"].auth, "base64").toString()).toBe("bot:pull-tok");
    const deploy = manifests.find((m) => m.kind === "Deployment") as unknown as {
      spec: { template: { spec: { imagePullSecrets?: Array<{ name: string }> } } };
    };
    expect(deploy.spec.template.spec.imagePullSecrets).toEqual([{ name: REGISTRY_AUTH_SECRET_NAME }]);
  });

  it("renders neither Secret nor imagePullSecrets when no image matches (no scattering of irrelevant credentials)", () => {
    const manifests = buildK8sManifests(withImage("quay.io/x/y:1"), { registryAuth: AUTH });
    expect(manifests.some((m) => m.kind === "Secret")).toBe(false);
    const deploy = manifests.find((m) => m.kind === "Deployment") as unknown as {
      spec: { template: { spec: { imagePullSecrets?: unknown } } };
    };
    expect(deploy.spec.template.spec.imagePullSecrets).toBeUndefined();
  });
});

describe("buildK8sManifests — OS placement (requires.os → nodeSelector, the portable os-<x> capability)", () => {
  type DeploySpec = { spec: { template: { spec: { nodeSelector?: Record<string, string> } } } };
  const deployNamed = (manifests: ReturnType<typeof buildK8sManifests>, name: string) =>
    manifests.find((m) => m.kind === "Deployment" && m.metadata.name === `bu-${name}`) as unknown as DeploySpec;

  it("emits kubernetes.io/os for a service that requires an OS; a service with no requirement stays ungated", () => {
    const spec: ServiceHarnessSpec = {
      ...SPEC,
      services: [
        { name: "agent", image: "a:1", port: 8000, needs: [], perRun: [], replicas: 1, env: {} },
        {
          name: "pw",
          image: "pw:1",
          port: 4444,
          needs: [],
          perRun: [],
          replicas: 1,
          env: {},
          requires: { os: "windows" },
        },
      ],
    };
    const manifests = buildK8sManifests(spec);
    expect(deployNamed(manifests, "pw").spec.template.spec.nodeSelector).toEqual({ "kubernetes.io/os": "windows" });
    expect(deployNamed(manifests, "agent").spec.template.spec.nodeSelector).toBeUndefined();
  });

  it("maps macos → darwin (GOOS, the K8s node OS label value)", () => {
    const spec: ServiceHarnessSpec = {
      ...SPEC,
      services: [{ name: "mac", image: "m:1", needs: [], perRun: [], replicas: 1, env: {}, requires: { os: "macos" } }],
    };
    expect(deployNamed(buildK8sManifests(spec), "mac").spec.template.spec.nodeSelector).toEqual({
      "kubernetes.io/os": "darwin",
    });
  });
});

describe("buildBrowserManifests (K8s)", () => {
  it("renders a headless Chromium Deployment + Service into the namespace", () => {
    const m = buildBrowserManifests("r1", { namespace: "everdict-acme" });
    expect(m.map((x) => x.kind)).toEqual(["Deployment", "Service"]);
    expect(m[0]?.metadata.name).toBe(browserDeployName("r1"));
    expect(m[0]?.metadata.namespace).toBe("everdict-acme");
    const dep = m[0]?.spec as { template: { spec: { containers: Array<{ image: string; args: string[] }> } } };
    expect(dep.template.spec.containers[0]?.image).toBe(DEFAULT_BROWSER_IMAGE);
    expect(dep.template.spec.containers[0]?.args).toEqual(["--remote-allow-origins=*"]);
  });
  it("namespaceManifest", () => {
    expect(namespaceManifest("everdict-x")).toEqual({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: "everdict-x" },
    });
  });
});

describe("K8sTopologyRuntime", () => {
  it("discovers endpoints via apply(ns+manifests) → rollout → port-forward", async () => {
    const { kubectl, calls } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1 });
    const topo = await rt.ensureTopology(SPEC, ZONE("acme"));
    expect(topo.endpoints["agent-server"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(calls).toContain("ns:everdict-acme");
    expect(calls).toContain("rollout:everdict-acme/bu-agent-server");
    expect(calls).toContain("pf:everdict-acme/svc/bu-agent-server");
  });

  it("multi-tenant: separates the warm topology into a different namespace per zone", async () => {
    const { kubectl, calls } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1 });
    await rt.ensureTopology(SPEC, ZONE("alpha"));
    await rt.ensureTopology(SPEC, ZONE("beta"));
    expect(calls).toContain("ns:everdict-alpha");
    expect(calls).toContain("ns:everdict-beta"); // not shared — per-zone namespace
  });

  it("the warm pool deploys only once per (spec, version, zone) (cache)", async () => {
    const { kubectl, calls } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1 });
    await rt.ensureTopology(SPEC, ZONE("acme"));
    await rt.ensureTopology(SPEC, ZONE("acme")); // the second is cached
    expect(calls.filter((c) => c === "ns:everdict-acme")).toHaveLength(1);
  });

  it("single-flight: concurrent ensures of the same harness deploy the manifests only once", async () => {
    // Regression: the cache above only guards SEQUENTIAL re-ensures — the warm entry is written after rollout. Under
    // case-level parallelism (many cases of the same dataset+harness at once) concurrent ensures used to each re-apply
    // the SAME fixed-name Deployments and churn the rollout, so the services never came up together. Concurrent ensures
    // must share ONE deploy (the manifests are applied once).
    const { kubectl, calls } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1 });
    const [a, b, c] = await Promise.all([
      rt.ensureTopology(SPEC, ZONE("acme")),
      rt.ensureTopology(SPEC, ZONE("acme")),
      rt.ensureTopology(SPEC, ZONE("acme")),
    ]);
    expect(calls.filter((c) => c === "ns:everdict-acme")).toHaveLength(1); // one deploy, not one-per-caller
    expect(a).toBe(b); // all three callers share the single deploy's handle
    expect(b).toBe(c);
  });

  const POOL_ZONE = (id: string): TrustZone => ({
    id,
    isolationRuntime: "runc",
    namespace: `everdict-${id}`,
    network: "deny-cross-tenant",
    trusted: true,
    storeIsolation: "pool",
  });
  const SPEC_PG: ServiceHarnessSpec = {
    ...SPEC,
    dependencies: [{ store: "postgres", role: "checkpoints", purpose: "plumbing", isolateBy: "thread_id" }],
  };

  it("pool: deploys the shared store once + mints the tenant DB/role (psql exec) + injects a scoped DATABASE_URL into the service", async () => {
    const { kubectl, calls, applied } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1 });
    await rt.ensureTopology(SPEC_PG, POOL_ZONE("acme"));
    // deploys + rolls out the shared store into the pool namespace.
    expect(calls).toContain("ns:everdict-shared");
    expect(calls).toContain("rollout:everdict-shared/everdict-shared-postgres");
    // mints the tenant DB/role via admin psql (DDL over stdin).
    expect(calls.some((c) => c.startsWith("exec:everdict-shared/") && c.includes("psql") && c.includes("stdin"))).toBe(
      true,
    );
    // injects a scoped DATABASE_URL (tenant_acme/r_acme, shared-store DNS) into the service.
    const agent = applied.find(
      (m) => m.kind === "Deployment" && (m.metadata as { name: string }).name === "bu-agent-server",
    ) as { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } } };
    const env = Object.fromEntries(agent.spec.template.spec.containers[0]?.env.map((e) => [e.name, e.value]) ?? []);
    expect(env.DATABASE_URL).toMatch(
      /^postgresql:\/\/r_acme:.+@everdict-shared-postgres\.everdict-shared\.svc\.cluster\.local:5432\/tenant_acme$/,
    );
    // pool does not bring up a dedicated store in the zone ns (shared only).
    expect(applied.some((m) => (m.metadata as { name?: string })?.name === "bu-postgres")).toBe(false);
  });

  it("network: applies the zone ingress policy + shared-store ingress policy (cross-tenant block)", async () => {
    const { kubectl, applied } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1 });
    await rt.ensureTopology(SPEC_PG, POOL_ZONE("acme"));
    const policies = applied.filter((m) => m.kind === "NetworkPolicy");
    const names = policies.map((m) => (m.metadata as { name: string }).name);
    expect(names).toContain("everdict-zone-ingress"); // zone ns: same-ns ingress only
    expect(names).toContain("everdict-shared-store-ingress"); // shared store: managed ns only
  });

  it("network: applies no policies when networkPolicies:false", async () => {
    const { kubectl, applied } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1, networkPolicies: false });
    await rt.ensureTopology(SPEC_PG, POOL_ZONE("acme"));
    expect(applied.some((m) => m.kind === "NetworkPolicy")).toBe(false);
  });

  it("pool: the shared store is deployed only once per cluster (shared by multiple tenants)", async () => {
    const { kubectl, calls } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1 });
    await rt.ensureTopology(SPEC_PG, POOL_ZONE("acme"));
    await rt.ensureTopology(SPEC_PG, POOL_ZONE("globex"));
    expect(calls.filter((c) => c === "rollout:everdict-shared/everdict-shared-postgres")).toHaveLength(1);
    // but per-tenant mint still runs for each (twice).
    expect(calls.filter((c) => c.startsWith("exec:everdict-shared/") && c.includes("psql"))).toHaveLength(2);
  });

  it("per-case browser dispose removes only the browser resources (keeps the namespace)", async () => {
    const { kubectl, calls } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1 });
    const env = await rt.provisionBrowserEnv(SPEC, "run1", ZONE("acme"));
    await env.dispose();
    expect(calls).toContain(
      `del:everdict-acme/deployment/${browserDeployName("run1")}+service/${browserDeployName("run1")}`,
    );
    expect(calls.some((c) => c.startsWith("delns:"))).toBe(false); // does not delete the ns
  });

  const SPEC_DATA: ServiceHarnessSpec = {
    ...SPEC,
    dependencies: [{ store: "postgres", role: "world", purpose: "data", isolateBy: "schema" }],
  };

  it("seedFixtures: execs the postgres seed into the dedicated store pod's schema slice (P2, silo)", async () => {
    const { kubectl, calls } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1, provisionDependencies: true });
    await rt.seedFixtures(SPEC_DATA, "run1", [
      {
        store: "postgres",
        role: "world",
        isolateBy: "schema",
        slice: "run_run1",
        seed: { inline: "INSERT INTO t VALUES (1);" },
        format: "sql",
      },
    ]);
    expect(calls.some((c) => c.startsWith("podFor:") && c.includes("app=bu-postgres"))).toBe(true);
    expect(
      calls.some(
        (c) => c.startsWith("exec:") && c.includes("psql") && c.includes('CREATE SCHEMA IF NOT EXISTS "run_run1"'),
      ),
    ).toBe(true);
  });

  it("readStoreState: reads the schema slice via psql in the store pod and returns stdout (P2, silo)", async () => {
    const { kubectl, calls } = fakeKubectl("1|alice\n");
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1, provisionDependencies: true });
    const out = await rt.readStoreState(SPEC_DATA, "run1", {
      store: "postgres",
      role: "world",
      query: "SELECT id,name FROM t",
    });
    expect(out).toBe("1|alice\n");
    expect(
      calls.some(
        (c) =>
          c.startsWith("exec:") && c.includes('SET search_path TO "run_run1"') && c.includes("SELECT id,name FROM t"),
      ),
    ).toBe(true);
  });

  it("seedFixtures: rejects a store on a runtime that deploys none (dedicated-silo only)", async () => {
    const { kubectl } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1 }); // provisionDependencies unset → external
    await expect(
      rt.seedFixtures(SPEC_DATA, "run1", [
        {
          store: "postgres",
          role: "world",
          isolateBy: "schema",
          slice: "run_run1",
          seed: { inline: "x" },
          format: "sql",
        },
      ]),
    ).rejects.toThrow(/dedicated/);
  });
});
