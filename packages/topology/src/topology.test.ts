import type { AgentJob, BrowserSnapshot, ServiceHarnessSpec, TraceEvent } from "@assay/core";
import type { TraceSource } from "@assay/trace";
import { describe, expect, it } from "vitest";
import { keysFor } from "./environment-manager.js";
import { buildK8sManifests } from "./k8s-topology.js";
import { type AllocLike, browserJobId, buildBrowserJob, buildNomadTopologyJob, resolvePort } from "./nomad-topology.js";
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
});
