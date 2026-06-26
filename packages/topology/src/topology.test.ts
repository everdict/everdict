import { perTenantTrustZones } from "@assay/backends";
import type { AgentJob, BrowserSnapshot, Grader, ServiceHarnessSpec, TraceEvent, TrustZone } from "@assay/core";
import type { TraceSource } from "@assay/trace";
import { describe, expect, it } from "vitest";
import { buildSharedStoreManifests } from "./dependencies.js";
import { keysFor } from "./environment-manager.js";
import type { FrontDoorDriver } from "./front-door-driver.js";
import { buildK8sManifests } from "./k8s-topology.js";
import {
  type AllocLike,
  SHARED_STORE_JOB_ID,
  browserJobId,
  buildBrowserJob,
  buildDedicatedStoreJob,
  buildNomadTopologyJob,
  buildSharedStoreJob,
  resolvePort,
  topologyJobId,
} from "./nomad-topology.js";
import { ServiceTopologyBackend, type SubmitFn } from "./service-backend.js";
import type { TargetEnvHandle, TopologyRuntime } from "./topology-runtime.js";

const SPEC: ServiceHarnessSpec = {
  kind: "service",
  id: "browser-use-langgraph",
  version: "1.0.0",
  services: [
    {
      name: "agent-server",
      image: "reg/bu-agent:1",
      port: 8000,
      needs: ["postgres", "redis", "browser-mcp"],
      perRun: ["thread_id"],
      replicas: 1,
    },
    { name: "browser-mcp", image: "reg/bu-mcp:1", port: 9000, needs: [], perRun: [], replicas: 1 },
    { name: "action-stream", image: "reg/bu-actionstream:1", port: 8080, needs: ["redis"], perRun: [], replicas: 1 },
  ],
  dependencies: [
    { store: "postgres", role: "checkpoints", isolateBy: "thread_id" },
    { store: "redis", role: "action-stream", isolateBy: "key-prefix" },
    { store: "minio", role: "snapshots", isolateBy: "object-prefix" },
  ],
  target: {
    kind: "browser",
    engine: "chromium",
    extension: { ref: "reg/lupin-ext:1" },
    lifecycle: "per-case-instance",
    observe: ["dom", "screenshot", "url"],
  },
  frontDoor: { service: "agent-server", submit: "POST /runs", trace: "GET /runs/{id}/events" },
  traceSource: { kind: "mlflow", endpoint: "http://mlflow:5000" },
};

describe("buildNomadTopologyJob", () => {
  it("서비스마다 task group + docker/runsc 로 렌더한다", () => {
    const job = buildNomadTopologyJob(SPEC, { runtime: "runsc", storeEnv: { PG_URL: "x" } });
    expect(job.Job.Type).toBe("service");
    expect(job.Job.TaskGroups.map((g) => g.Name)).toEqual(["agent-server", "browser-mcp", "action-stream"]);
    const agent = job.Job.TaskGroups[0]?.Tasks[0];
    expect(agent?.Config.image).toBe("reg/bu-agent:1");
    expect(agent?.Config.runtime).toBe("runsc");
    expect(agent?.Env.PG_URL).toBe("x");
  });

  it("port 가 있는 서비스에 dynamic port + docker 매핑을 단다 (호스트 발견용)", () => {
    const job = buildNomadTopologyJob(SPEC);
    const agentGroup = job.Job.TaskGroups[0];
    expect(agentGroup?.Networks?.[0]?.DynamicPorts?.[0]).toEqual({ Label: "http", To: 8000 });
    expect(agentGroup?.Tasks[0]?.Config.ports).toEqual(["http"]);
  });
});

describe("buildNomadTopologyJob — Connect mesh", () => {
  it("connect 면 bridge 네트워크 + 메시 service(sidecar) + 같은 테넌트 needs 를 upstream 으로 렌더한다", () => {
    const job = buildNomadTopologyJob(SPEC, { connect: true, zoneId: "acme" });
    const agent = job.Job.TaskGroups.find((g) => g.Name === "agent-server");
    expect(agent?.Networks?.[0]?.Mode).toBe("bridge");
    const svc = agent?.Services?.[0];
    expect(svc?.Name).toBe("t-acme-agent-server"); // 메시 서비스명(테넌트 prefix)
    expect(svc?.Connect.SidecarService).toBeDefined();
    // agent-server.needs = [postgres, redis, browser-mcp] → 서비스인 browser-mcp 만 upstream(스토어 제외).
    const ups = svc?.Connect.SidecarService.Proxy?.Upstreams ?? [];
    expect(ups.map((u) => u.DestinationName)).toEqual(["t-acme-browser-mcp"]);
  });

  it("connect 없으면 메시 service 를 렌더하지 않는다(기존 동작)", () => {
    const job = buildNomadTopologyJob(SPEC, { zoneId: "acme" });
    expect(job.Job.TaskGroups.every((g) => g.Services === undefined)).toBe(true);
    expect(job.Job.TaskGroups[0]?.Networks?.[0]?.Mode).toBeUndefined();
  });
});

describe("buildBrowserJob", () => {
  it("per-case headless Chromium(service) + CDP dynamic port 로 렌더한다", () => {
    const job = buildBrowserJob(SPEC, "abc", { runtime: "runsc" });
    expect(job.Job.ID).toBe(browserJobId("abc"));
    expect(job.Job.Type).toBe("service");
    const g = job.Job.TaskGroups[0];
    expect(g?.Name).toBe("browser");
    expect(g?.Networks?.[0]?.DynamicPorts?.[0]).toEqual({ Label: "cdp", To: 9222 });
    const task = g?.Tasks[0];
    expect(task?.Config.image).toBe("chromedp/headless-shell:latest");
    expect(task?.Config.runtime).toBe("runsc");
    expect(task?.Config.ports).toEqual(["cdp"]);
    // headless-shell 은 CDP 를 스스로 9222 로 노출 → 포트 덮어쓰기 금지, allow-origins 만 추가.
    expect(task?.Config.args).toEqual(["--remote-allow-origins=*"]);
    expect(task?.Env.ASSAY_RUN_ID).toBe("abc");
  });
});

describe("topologyJobId (trust-zone keying)", () => {
  it("zoneId 가 있으면 warm 잡 ID 에 섞어 테넌트 간 공유를 막는다", () => {
    expect(topologyJobId(SPEC)).toBe("assay-harness-browser-use-langgraph-1.0.0");
    expect(topologyJobId(SPEC, "acme")).toBe("assay-harness-browser-use-langgraph-1.0.0-acme");
    expect(topologyJobId(SPEC, "a")).not.toBe(topologyJobId(SPEC, "b"));
  });
});

describe("resolvePort", () => {
  it("AllocatedResources.Shared.Ports 에서 label 로 host:port 를 찾는다", () => {
    const alloc: AllocLike = {
      AllocatedResources: { Shared: { Ports: [{ Label: "http", Value: 21500, To: 8080, HostIP: "127.0.0.1" }] } },
    };
    expect(resolvePort(alloc, "http")).toEqual({ hostIp: "127.0.0.1", port: 21500 });
  });

  it("구 Resources.Networks 형태도 지원하고, HostIP 없으면 127.0.0.1 로 채운다", () => {
    const alloc: AllocLike = { Resources: { Networks: [{ DynamicPorts: [{ Label: "cdp", Value: 30222 }] }] } };
    expect(resolvePort(alloc, "cdp")).toEqual({ hostIp: "127.0.0.1", port: 30222 });
  });

  it("label 이 없으면 undefined", () => {
    expect(resolvePort({}, "http")).toBeUndefined();
  });
});

describe("provisionDependencies (스토어 공동 배포 + 접속 env 자동 와이어링)", () => {
  it("K8s: provisionDependencies 면 PG/Redis Deployment+Service 를 렌더한다(타입별 1개)", () => {
    const manifests = buildK8sManifests(SPEC, { namespace: "assay-acme", provisionDependencies: true });
    const names = manifests
      .filter((m) => m.kind === "Deployment")
      .map((m) => m.metadata.name)
      .sort();
    // 서비스 3 + 선언된 스토어(postgres/redis/minio) 전부 배포.
    expect(names).toContain("browser-use-langgraph-postgres");
    expect(names).toContain("browser-use-langgraph-redis");
    expect(names).toContain("browser-use-langgraph-minio");
    const pg = manifests.find(
      (m) => m.kind === "Deployment" && m.metadata.name === "browser-use-langgraph-postgres",
    ) as { spec: { template: { spec: { containers: Array<{ image: string }> } } } };
    expect(pg.spec.template.spec.containers[0]?.image).toBe("postgres:16-alpine");
  });

  it("K8s: 서비스 env 에 DATABASE_URL/REDIS_URL 을 스토어 DNS 로 자동 주입한다", () => {
    const manifests = buildK8sManifests(SPEC, { namespace: "assay-acme", provisionDependencies: true });
    const agent = manifests.find(
      (m) => m.kind === "Deployment" && m.metadata.name === "browser-use-langgraph-agent-server",
    ) as { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } } };
    const env = Object.fromEntries(agent.spec.template.spec.containers[0]?.env.map((e) => [e.name, e.value]) ?? []);
    expect(env.DATABASE_URL).toBe("postgresql://assay:assay@browser-use-langgraph-postgres:5432/assay");
    expect(env.REDIS_URL).toBe("redis://browser-use-langgraph-redis:6379");
  });

  it("K8s: 명시 storeEnv 가 자동 connEnv 를 덮어쓴다(harness 별 변수명)", () => {
    const manifests = buildK8sManifests(SPEC, {
      provisionDependencies: true,
      storeEnv: { DATABASE_URL: "postgresql://custom/db" },
    });
    const agent = manifests.find(
      (m) => m.kind === "Deployment" && m.metadata.name === "browser-use-langgraph-agent-server",
    ) as { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } } };
    const env = Object.fromEntries(agent.spec.template.spec.containers[0]?.env.map((e) => [e.name, e.value]) ?? []);
    expect(env.DATABASE_URL).toBe("postgresql://custom/db"); // 명시값 우선
  });

  it("K8s: provisionDependencies 없으면 스토어를 배포하지 않는다(기존 동작)", () => {
    const manifests = buildK8sManifests(SPEC);
    expect(manifests.some((m) => m.metadata.name.endsWith("-postgres"))).toBe(false);
  });

  it("Nomad: provisionDependencies 면 스토어 task group 을 같은 잡에 추가한다(dynamic port)", () => {
    const job = buildNomadTopologyJob(SPEC, { provisionDependencies: true });
    const groups = job.Job.TaskGroups.map((g) => g.Name);
    expect(groups).toContain("browser-use-langgraph-postgres");
    expect(groups).toContain("browser-use-langgraph-redis");
    const pg = job.Job.TaskGroups.find((g) => g.Name === "browser-use-langgraph-postgres");
    expect(pg?.Networks?.[0]?.DynamicPorts?.[0]).toEqual({ Label: "store", To: 5432 });
    expect(pg?.Tasks[0]?.Config.image).toBe("postgres:16-alpine");
  });

  it("Nomad pool: buildSharedStoreJob 은 공유 스토어 잡(클러스터 1개)을 렌더한다", () => {
    const job = buildSharedStoreJob(["postgres", "redis"]);
    expect(job.Job.ID).toBe(SHARED_STORE_JOB_ID);
    expect(job.Job.TaskGroups.map((g) => g.Name).sort()).toEqual(["assay-shared-postgres", "assay-shared-redis"]);
    const pg = job.Job.TaskGroups.find((g) => g.Name === "assay-shared-postgres");
    expect(pg?.Networks?.[0]?.DynamicPorts?.[0]).toEqual({ Label: "store", To: 5432 });
  });

  it("minio: 스토어 args(server /data)를 K8s/Nomad 빌더에 모두 렌더한다", () => {
    const k8s = buildSharedStoreManifests(["minio"], "assay-shared") as Array<{
      kind: string;
      spec?: { template?: { spec: { containers: Array<{ image: string; args?: string[] }> } } };
    }>;
    const dep = k8s.find((m) => m.kind === "Deployment");
    expect(dep?.spec?.template?.spec.containers[0]?.image).toBe("quay.io/minio/minio:latest");
    expect(dep?.spec?.template?.spec.containers[0]?.args).toEqual(["server", "/data"]);
    const nomad = buildSharedStoreJob(["minio"]);
    expect(nomad.Job.TaskGroups[0]?.Tasks[0]?.Config.args).toEqual(["server", "/data"]);
  });

  it("Nomad silo: buildDedicatedStoreJob 은 존별 전용 스토어 잡(zone-suffixed)을 렌더한다", () => {
    const job = buildDedicatedStoreJob(SPEC, ["postgres"], "acme");
    expect(job.Job.ID).toBe("assay-store-browser-use-langgraph-acme");
    expect(job.Job.TaskGroups.map((g) => g.Name)).toEqual(["assay-store-acme-postgres"]);
    expect(job.Job.TaskGroups[0]?.Networks?.[0]?.DynamicPorts?.[0]).toEqual({ Label: "store", To: 5432 });
  });
});

describe("buildK8sManifests", () => {
  it("서비스마다 Deployment(+runtimeClass) + Service 로 렌더한다", () => {
    const manifests = buildK8sManifests(SPEC, { runtimeClass: "gvisor" });
    const deploys = manifests.filter((m) => m.kind === "Deployment");
    const svcs = manifests.filter((m) => m.kind === "Service");
    expect(deploys.map((d) => d.metadata.name)).toEqual([
      "browser-use-langgraph-agent-server",
      "browser-use-langgraph-browser-mcp",
      "browser-use-langgraph-action-stream",
    ]);
    expect(svcs).toHaveLength(3);
    const dep0 = deploys[0]?.spec as {
      template: { spec: { runtimeClassName?: string; containers: Array<{ image: string }> } };
    };
    expect(dep0.template.spec.runtimeClassName).toBe("gvisor");
    expect(dep0.template.spec.containers[0]?.image).toBe("reg/bu-agent:1");
  });
});

describe("ServiceTopologyBackend (orchestrator-agnostic, mock runtime)", () => {
  it("warm 토폴로지 + per-case 브라우저로 구동하고 per-run wiring 을 주입한다", async () => {
    const recorded: Record<string, unknown>[] = [];
    const submit: SubmitFn = async (_url, payload) => {
      recorded.push(payload);
    };
    const browserSnap: BrowserSnapshot = {
      kind: "browser",
      url: "https://x",
      dom: "<html/>",
      screenshotRef: "runs/fixed/shot.png",
      console: [],
    };
    const browser: TargetEnvHandle = {
      wiring: { target_cdp_url: "ws://browser/ctx" },
      async snapshot() {
        return browserSnap;
      },
      async dispose() {},
    };
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        return browser;
      },
    };
    const trace: TraceEvent[] = [
      { t: 0, kind: "tool_call", id: "1", name: "browser.click", args: {} },
      { t: 1, kind: "llm_call", model: "m", cost: { inputTokens: 5, outputTokens: 1, usd: 0.02 } },
    ];
    const traceSource: TraceSource = {
      async fetch() {
        return trace;
      },
    };

    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource,
      specFor: () => SPEC,
      submit,
      newRunId: () => "fixed",
    });

    const job: AgentJob = {
      harness: { id: "browser-use-langgraph", version: "1.0.0" },
      evalCase: {
        id: "c1",
        env: { kind: "browser", startUrl: "https://x" },
        task: "do it",
        graders: [],
        timeoutSec: 60,
        tags: [],
      },
    };

    const result = await backend.dispatch(job);

    expect(result.harness).toBe("browser-use-langgraph@1.0.0");
    expect(result.snapshot.kind).toBe("browser");
    expect(result.scores.map((s) => s.graderId).sort()).toEqual(["cost", "latency", "steps"]);
    // per-run wiring 주입 확인
    expect(recorded[0]?.thread_id).toBe(keysFor("fixed").threadId);
    expect(recorded[0]?.browser_cdp_url).toBe("ws://browser/ctx");
    expect(recorded[0]?.minio_prefix).toBe("runs/fixed/");
  });

  it("delivery sentinel: 관측물을 front-door 응답(결과 채널)에서 인라인 회수한다(브라우저 pull 아님)", async () => {
    // 응답으로 돌아오는 관측물 — 프로비저닝된 브라우저 스냅샷과 다르게 둬서 sentinel 이 응답에서 읽음을 확증.
    const fromResponse: BrowserSnapshot = {
      kind: "browser",
      url: "https://sentinel",
      dom: "<from-response/>",
      screenshotRef: "r",
      console: [],
    };
    const fromBrowser: BrowserSnapshot = { kind: "browser", url: "https://pulled", dom: "<pulled/>", console: [] };
    const submit: SubmitFn = async () => ({ observation: fromResponse });
    const browser: TargetEnvHandle = {
      wiring: { target_cdp_url: "ws://browser/ctx" },
      async snapshot() {
        return fromBrowser; // sentinel 이면 이 pull 값은 무시돼야 한다
      },
      async dispose() {},
    };
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        return browser;
      },
    };
    const traceSource: TraceSource = {
      async fetch() {
        return [];
      },
    };
    const sentinelSpec: ServiceHarnessSpec = {
      ...SPEC,
      target: {
        kind: "browser",
        engine: "chromium",
        lifecycle: "per-case-instance",
        observe: ["dom"],
        delivery: { mode: "sentinel", path: "observation" },
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource,
      specFor: () => sentinelSpec,
      submit,
      newRunId: () => "fixed",
    });
    const job: AgentJob = {
      harness: { id: "bu", version: "1.0.0" },
      evalCase: {
        id: "c1",
        env: { kind: "browser", startUrl: "https://x" },
        task: "do it",
        graders: [],
        timeoutSec: 60,
        tags: [],
      },
    };

    const result = await backend.dispatch(job);
    expect(result.snapshot).toEqual(fromResponse); // 브라우저 pull(fromBrowser)이 아니라 응답에서 회수
  });

  it("delivery egress: 관측물을 sink({run_id} 보간)에서 GET 으로 회수한다(에이전트가 push 한 위치)", async () => {
    const fromSink: BrowserSnapshot = {
      kind: "browser",
      url: "https://egress",
      dom: "<from-sink/>",
      screenshotRef: "r",
      console: [],
    };
    let fetchedUrl = "";
    const browser: TargetEnvHandle = {
      wiring: { target_cdp_url: "ws://browser/ctx" },
      async snapshot() {
        return { kind: "browser", url: "https://pulled", dom: "<pulled/>", console: [] };
      },
      async dispose() {},
    };
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        return browser;
      },
    };
    const traceSource: TraceSource = {
      async fetch() {
        return [];
      },
    };
    const egressSpec: ServiceHarnessSpec = {
      ...SPEC,
      target: {
        kind: "browser",
        engine: "chromium",
        lifecycle: "per-case-instance",
        observe: ["dom"],
        delivery: { mode: "egress", sink: "http://sink/runs/{run_id}/obs.json" },
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource,
      specFor: () => egressSpec,
      submit: async () => ({}),
      getJson: async (url) => {
        fetchedUrl = url;
        return fromSink;
      },
      newRunId: () => "fixed",
    });
    const job: AgentJob = {
      harness: { id: "bu", version: "1.0.0" },
      evalCase: {
        id: "c1",
        env: { kind: "browser", startUrl: "https://x" },
        task: "do it",
        graders: [],
        timeoutSec: 60,
        tags: [],
      },
    };

    const result = await backend.dispatch(job);
    expect(fetchedUrl).toBe("http://sink/runs/fixed/obs.json"); // {run_id} = runId 로 보간
    expect(result.snapshot).toEqual(fromSink); // 브라우저 pull 아니라 sink 에서 회수
  });

  it("트레이스 소스 장애는 run 을 죽이지 않는다 — error 이벤트로 기록하고 스냅샷+채점은 진행", async () => {
    const browserSnap: BrowserSnapshot = { kind: "browser", url: "https://x", dom: "<html/>", console: [] };
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        return {
          wiring: { target_cdp_url: "ws://b" },
          async snapshot() {
            return browserSnap;
          },
          async dispose() {},
        };
      },
    };
    // 트레이스 소스가 던진다(인증/일시 down/미배출 모사).
    const traceSource: TraceSource = {
      async fetch() {
        throw new Error("MLflow 401 Unauthorized");
      },
    };
    // 스냅샷 기반 그레이더만 — 트레이스가 비어도 브라우저 결과로 채점 가능.
    const urlGrader: Grader = {
      id: "url-ok",
      async grade(ctx) {
        const u = ctx.snapshot?.kind === "browser" ? ctx.snapshot.url : "";
        return { graderId: "url-ok", metric: "url", value: u ? 1 : 0, pass: u === "https://x", detail: u };
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource,
      specFor: () => SPEC,
      submit: async () => {},
      graders: [urlGrader],
      newRunId: () => "fixed",
    });
    const job: AgentJob = {
      harness: { id: "browser-use-langgraph", version: "1.0.0" },
      evalCase: { id: "c1", env: { kind: "browser" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    };

    const result = await backend.dispatch(job);

    // dispatch 가 throw 하지 않고 완료된다.
    expect(result.scores.find((s) => s.graderId === "url-ok")?.pass).toBe(true);
    // 트레이스는 침묵 손실 대신 error 이벤트로 가시화된다.
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]?.kind).toBe("error");
    expect((result.trace[0] as { message?: string }).message).toContain("MLflow 401");
  });

  it("멀티테넌트: 테넌트마다 다른 trust-zone 으로 warm 토폴로지를 분리한다(공유 금지)", async () => {
    const zonesSeen: Array<TrustZone | undefined> = [];
    const browser: TargetEnvHandle = {
      wiring: { target_cdp_url: "ws://b" },
      async snapshot() {
        return { kind: "browser", url: "about:blank", dom: "", console: [] };
      },
      async dispose() {},
    };
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology(_spec, zone) {
        zonesSeen.push(zone);
        return { endpoints: { "agent-server": "http://agent:8000" } };
      },
      async provisionBrowserEnv() {
        return browser;
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC,
      submit: async () => {},
      newRunId: () => "r",
      trustZones: perTenantTrustZones(),
    });
    const mk = (tenant: string): AgentJob => ({
      harness: { id: "browser-use-langgraph", version: "1.0.0" },
      tenant,
      evalCase: { id: `c-${tenant}`, env: { kind: "browser" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    });

    await backend.dispatch(mk("alpha"));
    await backend.dispatch(mk("beta"));

    expect(zonesSeen.map((z) => z?.id)).toEqual(["alpha", "beta"]);
    expect(zonesSeen.map((z) => z?.namespace)).toEqual(["assay-alpha", "assay-beta"]); // 존별 분리
    expect(zonesSeen.every((z) => z?.isolationRuntime === "runsc")).toBe(true); // 강격리 강제
  });

  // --- #2 완료 모델(completion) ---
  const mockBrowser = (): { handle: TargetEnvHandle; disposed: () => boolean } => {
    let disposed = false;
    return {
      handle: {
        wiring: { target_cdp_url: "ws://b" },
        async snapshot() {
          return { kind: "browser", url: "https://x", dom: "<html/>", console: [] };
        },
        async dispose() {
          disposed = true;
        },
      },
      disposed: () => disposed,
    };
  };
  const mockRuntime = (browser: TargetEnvHandle): TopologyRuntime => ({
    id: "mock",
    async ensureTopology() {
      return { endpoints: { "agent-server": "http://agent-server:8000" } };
    },
    async provisionBrowserEnv() {
      return browser;
    },
  });
  const job: AgentJob = {
    harness: { id: "browser-use-langgraph", version: "1.0.0" },
    evalCase: { id: "c1", env: { kind: "browser" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
  };

  it("완료 모델이 timeout 을 돌려주면 dispatch 가 HARNESS_RUN_FAILED 로 실패하고 브라우저를 정리한다", async () => {
    const b = mockBrowser();
    const driver: FrontDoorDriver = {
      async drive() {
        return { traceRef: "fixed", status: "timeout" };
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(b.handle),
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC,
      frontDoorDriver: driver,
      newRunId: () => "fixed",
    });

    const err = await backend.dispatch(job).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("HARNESS_RUN_FAILED");
    expect(b.disposed()).toBe(true); // finally 로 per-case 브라우저 정리
  });

  it("완료 모델이 failed 를 돌려줘도 스냅샷+트레이스로 채점은 진행한다", async () => {
    const b = mockBrowser();
    const driver: FrontDoorDriver = {
      async drive() {
        return { traceRef: "fixed", status: "failed" };
      },
    };
    const trace: TraceEvent[] = [
      { t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.01 } },
    ];
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(b.handle),
      traceSource: {
        async fetch() {
          return trace;
        },
      },
      specFor: () => SPEC,
      frontDoorDriver: driver,
      newRunId: () => "fixed",
    });

    const result = await backend.dispatch(job);

    expect(result.scores.map((s) => s.graderId).sort()).toEqual(["cost", "latency", "steps"]);
    expect(b.disposed()).toBe(true);
  });

  it("poll 완료 모델: 상태 엔드포인트를 run_id 로 보간해 폴링하고 done 이면 채점한다", async () => {
    const polled: string[] = [];
    const b = mockBrowser();
    const SPEC_POLL: ServiceHarnessSpec = {
      ...SPEC,
      frontDoor: {
        ...SPEC.frontDoor,
        completion: {
          mode: "poll",
          statusPath: "GET /runs/{run_id}/status",
          done: { field: "status", equals: "done" },
          intervalMs: 1,
          timeoutMs: 100_000,
        },
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(b.handle),
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC_POLL,
      submit: async () => {},
      getJson: async (url) => {
        polled.push(url);
        return { status: "done" };
      },
      newRunId: () => "fixed",
    });

    const result = await backend.dispatch(job);

    expect(polled).toHaveLength(1);
    expect(polled[0]).toBe("http://agent-server:8000/runs/fixed/status"); // {run_id}→fixed 보간
    expect(result.scores.length).toBeGreaterThan(0);
  });

  // --- #3 상관(correlate) ---
  it("correlate returned: 에이전트가 submit 응답으로 돌려준 id 로 트레이스를 가져온다", async () => {
    const b = mockBrowser();
    let fetchedWith = "";
    const SPEC_RETURNED: ServiceHarnessSpec = {
      ...SPEC,
      frontDoor: { ...SPEC.frontDoor, correlate: { mode: "returned", path: "run_id" } },
    };
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(b.handle),
      traceSource: {
        async fetch(id) {
          fetchedWith = id;
          return [];
        },
      },
      specFor: () => SPEC_RETURNED,
      submit: async () => ({ run_id: "agent-xyz" }),
      newRunId: () => "fixed",
    });

    const result = await backend.dispatch(job);

    expect(result.caseId).toBe("c1");
    expect(fetchedWith).toBe("agent-xyz"); // assay runId(fixed)가 아니라 에이전트가 돌려준 id 로 상관
  });

  // --- #1 본문 템플릿(request.bodyTemplate) ---
  it("request.bodyTemplate 가 있으면 isolateBy 파생 wiring 으로 보간한 본문을 보낸다", async () => {
    const b = mockBrowser();
    let sent: Record<string, unknown> = {};
    const SPEC_TMPL: ServiceHarnessSpec = {
      ...SPEC,
      frontDoor: {
        ...SPEC.frontDoor,
        request: {
          bodyTemplate: {
            prompt: "{{task}}",
            run: "{{run_id}}",
            thread: "{{thread_id}}",
            obj: "{{object_prefix}}",
            cdp: "{{target_cdp_url}}",
          },
        },
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(b.handle),
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC_TMPL,
      submit: async (_url, payload) => {
        sent = payload;
      },
      newRunId: () => "fixed",
    });

    await backend.dispatch(job);

    // 현행 LangGraph 고정 이름(stream_channel/minio_prefix)이 아니라 isolateBy 파생 변수로 보간된다.
    expect(sent).toEqual({
      prompt: "t", // job.task
      run: "fixed",
      thread: "run-fixed", // postgres isolateBy: thread_id
      obj: "runs/fixed/", // minio isolateBy: object-prefix → object_prefix
      cdp: "ws://b", // target_cdp_url
    });
  });

  it("타깃 wiring 의 임의 좌표(target_cdp_url 외)가 본문 템플릿 어휘로 흐른다 (B1 — 어휘 개방)", async () => {
    let sent: Record<string, unknown> = {};
    // 타깃이 CDP 한 좌표를 넘어 세션형 좌표(playwright_server_url/session_id)를 함께 기여 — 핸들이 bag.
    const handle: TargetEnvHandle = {
      wiring: { target_cdp_url: "ws://b", playwright_server_url: "ws://pw/session-9", session_id: "sess-9" },
      async snapshot() {
        return { kind: "browser", url: "https://x", dom: "", console: [] };
      },
      async dispose() {},
    };
    const SPEC_TMPL: ServiceHarnessSpec = {
      ...SPEC,
      frontDoor: {
        ...SPEC.frontDoor,
        request: {
          bodyTemplate: { pw: "{{playwright_server_url}}", sid: "{{session_id}}", cdp: "{{target_cdp_url}}" },
        },
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(handle),
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC_TMPL,
      submit: async (_url, payload) => {
        sent = payload;
      },
      newRunId: () => "fixed",
    });

    await backend.dispatch(job);

    // 고정 어휘(task/target_cdp_url)가 아니라 타깃이 선언한 임의 좌표가 그대로 보간된다.
    expect(sent).toEqual({ pw: "ws://pw/session-9", sid: "sess-9", cdp: "ws://b" });
  });

  it("request 미지정이면 현행 browser-use 5-field 본문 그대로(무회귀)", async () => {
    const b = mockBrowser();
    let sent: Record<string, unknown> = {};
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(b.handle),
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC, // request 없음
      submit: async (_url, payload) => {
        sent = payload;
      },
      newRunId: () => "fixed",
    });

    await backend.dispatch(job);

    expect(sent).toEqual({
      task: "t",
      thread_id: "run-fixed",
      stream_channel: "run-fixed",
      minio_prefix: "runs/fixed/",
      browser_cdp_url: "ws://b",
    });
  });

  // --- #4 타깃 관측(spec.target optional) ---
  it("spec.target 이 없으면 브라우저를 프로비저닝하지 않고 trace-only(prompt 스냅샷)로 채점한다", async () => {
    let provisioned = false;
    let sent: Record<string, unknown> = {};
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        provisioned = true;
        throw new Error("target 이 없으면 호출돼선 안 된다");
      },
    };
    const SPEC_NO_TARGET: ServiceHarnessSpec = {
      kind: "service",
      id: SPEC.id,
      version: SPEC.version,
      services: SPEC.services,
      dependencies: SPEC.dependencies,
      frontDoor: SPEC.frontDoor,
      traceSource: SPEC.traceSource,
    }; // target 생략
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource: {
        async fetch() {
          return [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.01 } }];
        },
      },
      specFor: () => SPEC_NO_TARGET,
      submit: async (_url, payload) => {
        sent = payload;
      },
      newRunId: () => "fixed",
    });

    const result = await backend.dispatch(job);

    expect(provisioned).toBe(false); // 브라우저 미프로비저닝
    expect(result.snapshot.kind).toBe("prompt"); // 무대 없음 → prompt 스냅샷
    expect(sent).not.toHaveProperty("browser_cdp_url"); // 타깃 없으니 본문에서 cdp 제외
    expect(result.scores.map((s) => s.graderId).sort()).toEqual(["cost", "latency", "steps"]); // trace-only 채점
  });

  // --- #5 per-service 이미지 핀(imagePins) ---
  it("imagePins: 등록 spec 의 서비스 이미지를 override 하고 결과 harness 라벨에 핀 버전을 반영한다", async () => {
    const b = mockBrowser();
    let ensuredSpec: ServiceHarnessSpec | undefined;
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology(spec) {
        ensuredSpec = spec;
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        return b.handle;
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC,
      submit: async () => {},
      newRunId: () => "fixed",
    });
    const pinnedJob: AgentJob = { ...job, imagePins: { "agent-server": "reg/bu-agent:2" } };

    const result = await backend.dispatch(pinnedJob);

    // ensureTopology 가 override 된 이미지로 호출됐다.
    expect(ensuredSpec?.services.find((s) => s.name === "agent-server")?.image).toBe("reg/bu-agent:2");
    // 결과 harness 라벨에 핀 버전이 반영(스코어카드가 변종을 구분) — warm 풀도 이 version 으로 분리된다.
    expect(result.harness).toMatch(/^browser-use-langgraph@1\.0\.0-pin-[0-9a-f]{8}$/);
  });
});
