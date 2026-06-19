import type { ServiceHarnessSpec, TrustZone } from "@assay/core";
import { describe, expect, it } from "vitest";
import { K8sTopologyRuntime } from "./k8s-runtime.js";
import { browserDeployName, buildBrowserManifests, namespaceManifest } from "./k8s-topology.js";
import type { Kubectl, PortForward } from "./kubectl.js";

const SPEC: ServiceHarnessSpec = {
  kind: "service",
  id: "bu",
  version: "1.0.0",
  services: [{ name: "agent-server", image: "reg/echo:1", port: 8080, needs: [], perRun: [], replicas: 1 }],
  dependencies: [],
  target: { kind: "browser", engine: "chromium", lifecycle: "per-case-instance", observe: ["url"] },
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://mlflow:5000" },
};

// 호출을 기록하는 가짜 kubectl; port-forward 는 고정 로컬 포트를 돌려준다.
function fakeKubectl(): { kubectl: Kubectl; calls: string[]; applied: Array<Record<string, unknown>> } {
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
      calls.push(`exec:${ns}/${pod}:${command[0]}${stdin ? ":stdin" : ""}`);
      return "";
    },
  };
  return { kubectl, calls, applied };
}

const okFetch = (async () =>
  new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://x" }))) as unknown as typeof fetch;

const ZONE = (id: string): TrustZone => ({
  id,
  isolationRuntime: "runsc",
  namespace: `assay-${id}`,
  network: "deny-cross-tenant",
  trusted: false,
});

describe("buildBrowserManifests (K8s)", () => {
  it("headless Chromium Deployment + Service 를 네임스페이스에 렌더한다", () => {
    const m = buildBrowserManifests("r1", { namespace: "assay-acme" });
    expect(m.map((x) => x.kind)).toEqual(["Deployment", "Service"]);
    expect(m[0]?.metadata.name).toBe(browserDeployName("r1"));
    expect(m[0]?.metadata.namespace).toBe("assay-acme");
    const dep = m[0]?.spec as { template: { spec: { containers: Array<{ image: string; args: string[] }> } } };
    expect(dep.template.spec.containers[0]?.image).toBe("chromedp/headless-shell:latest");
    expect(dep.template.spec.containers[0]?.args).toEqual(["--remote-allow-origins=*"]);
  });
  it("namespaceManifest", () => {
    expect(namespaceManifest("assay-x")).toEqual({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: "assay-x" },
    });
  });
});

describe("K8sTopologyRuntime", () => {
  it("apply(ns+manifests) → rollout → port-forward 로 엔드포인트를 발견한다", async () => {
    const { kubectl, calls } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1 });
    const topo = await rt.ensureTopology(SPEC, ZONE("acme"));
    expect(topo.endpoints["agent-server"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(calls).toContain("ns:assay-acme");
    expect(calls).toContain("rollout:assay-acme/bu-agent-server");
    expect(calls).toContain("pf:assay-acme/svc/bu-agent-server");
  });

  it("멀티테넌트: 존마다 다른 네임스페이스로 warm 토폴로지를 분리한다", async () => {
    const { kubectl, calls } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1 });
    await rt.ensureTopology(SPEC, ZONE("alpha"));
    await rt.ensureTopology(SPEC, ZONE("beta"));
    expect(calls).toContain("ns:assay-alpha");
    expect(calls).toContain("ns:assay-beta"); // 공유 아님 — 존별 네임스페이스
  });

  it("warm 풀은 (spec,version,zone) 당 한 번만 배포한다(캐시)", async () => {
    const { kubectl, calls } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1 });
    await rt.ensureTopology(SPEC, ZONE("acme"));
    await rt.ensureTopology(SPEC, ZONE("acme")); // 두 번째는 캐시
    expect(calls.filter((c) => c === "ns:assay-acme")).toHaveLength(1);
  });

  const POOL_ZONE = (id: string): TrustZone => ({
    id,
    isolationRuntime: "runc",
    namespace: `assay-${id}`,
    network: "deny-cross-tenant",
    trusted: true,
    storeIsolation: "pool",
  });
  const SPEC_PG: ServiceHarnessSpec = {
    ...SPEC,
    dependencies: [{ store: "postgres", role: "checkpoints", isolateBy: "thread_id" }],
  };

  it("pool: 공유 스토어 1회 배포 + 테넌트 DB/role mint(psql exec) + 서비스에 scoped DATABASE_URL 주입", async () => {
    const { kubectl, calls, applied } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1 });
    await rt.ensureTopology(SPEC_PG, POOL_ZONE("acme"));
    // 공유 스토어를 pool 네임스페이스에 배포 + rollout.
    expect(calls).toContain("ns:assay-shared");
    expect(calls).toContain("rollout:assay-shared/assay-shared-postgres");
    // 어드민 psql 로 테넌트 DB/role mint(stdin 으로 DDL).
    expect(calls.some((c) => c.startsWith("exec:assay-shared/") && c.includes("psql") && c.includes("stdin"))).toBe(
      true,
    );
    // 서비스에 scoped DATABASE_URL(tenant_acme/r_acme, 공유 스토어 DNS) 주입.
    const agent = applied.find(
      (m) => m.kind === "Deployment" && (m.metadata as { name: string }).name === "bu-agent-server",
    ) as { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } } };
    const env = Object.fromEntries(agent.spec.template.spec.containers[0]?.env.map((e) => [e.name, e.value]) ?? []);
    expect(env.DATABASE_URL).toMatch(
      /^postgresql:\/\/r_acme:.+@assay-shared-postgres\.assay-shared\.svc\.cluster\.local:5432\/tenant_acme$/,
    );
    // pool 은 전용 스토어를 zone ns 에 띄우지 않는다(공유만).
    expect(applied.some((m) => (m.metadata as { name?: string })?.name === "bu-postgres")).toBe(false);
  });

  it("network: zone ingress 정책 + 공유스토어 ingress 정책을 적용한다(cross-tenant 차단)", async () => {
    const { kubectl, applied } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1 });
    await rt.ensureTopology(SPEC_PG, POOL_ZONE("acme"));
    const policies = applied.filter((m) => m.kind === "NetworkPolicy");
    const names = policies.map((m) => (m.metadata as { name: string }).name);
    expect(names).toContain("assay-zone-ingress"); // 존 ns: 같은-ns ingress 만
    expect(names).toContain("assay-shared-store-ingress"); // 공유스토어: managed ns 만
  });

  it("network: networkPolicies:false 면 정책을 적용하지 않는다", async () => {
    const { kubectl, applied } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1, networkPolicies: false });
    await rt.ensureTopology(SPEC_PG, POOL_ZONE("acme"));
    expect(applied.some((m) => m.kind === "NetworkPolicy")).toBe(false);
  });

  it("pool: 공유 스토어는 클러스터에 1회만 배포(여러 테넌트가 공유)", async () => {
    const { kubectl, calls } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1 });
    await rt.ensureTopology(SPEC_PG, POOL_ZONE("acme"));
    await rt.ensureTopology(SPEC_PG, POOL_ZONE("globex"));
    expect(calls.filter((c) => c === "rollout:assay-shared/assay-shared-postgres")).toHaveLength(1);
    // 그래도 테넌트별 mint 는 각각 실행(2회).
    expect(calls.filter((c) => c.startsWith("exec:assay-shared/") && c.includes("psql"))).toHaveLength(2);
  });

  it("per-case 브라우저 dispose 는 브라우저 리소스만 지운다(네임스페이스 유지)", async () => {
    const { kubectl, calls } = fakeKubectl();
    const rt = new K8sTopologyRuntime({ kubectl, fetchImpl: okFetch, pollIntervalMs: 1 });
    const env = await rt.provisionBrowserEnv(SPEC, "run1", ZONE("acme"));
    await env.dispose();
    expect(calls).toContain(
      `del:assay-acme/deployment/${browserDeployName("run1")}+service/${browserDeployName("run1")}`,
    );
    expect(calls.some((c) => c.startsWith("delns:"))).toBe(false); // ns 는 안 지움
  });
});
