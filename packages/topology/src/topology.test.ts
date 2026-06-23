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
import type { BrowserEnvHandle, TopologyRuntime } from "./topology-runtime.js";

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
    const browser: BrowserEnvHandle = {
      cdpUrl: "ws://browser/ctx",
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

  it("트레이스 소스 장애는 run 을 죽이지 않는다 — error 이벤트로 기록하고 스냅샷+채점은 진행", async () => {
    const browserSnap: BrowserSnapshot = { kind: "browser", url: "https://x", dom: "<html/>", console: [] };
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        return {
          cdpUrl: "ws://b",
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
    const browser: BrowserEnvHandle = {
      cdpUrl: "ws://b",
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
  const mockBrowser = (): { handle: BrowserEnvHandle; disposed: () => boolean } => {
    let disposed = false;
    return {
      handle: {
        cdpUrl: "ws://b",
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
  const mockRuntime = (browser: BrowserEnvHandle): TopologyRuntime => ({
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
});
