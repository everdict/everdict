import type { AgentJob, CaseResult } from "@assay/core";
import type { TopologyRuntime } from "@assay/topology";
import { describe, expect, it, vi } from "vitest";
import { resetSharedTopologyRuntime, runLeasedJob, sharedTopologyRuntime } from "./run-leased-job.js";

const evalCase: AgentJob["evalCase"] = {
  id: "c1",
  env: { kind: "repo", source: { files: {} } },
  task: "do x",
  graders: [],
  timeoutSec: 60,
  tags: [],
};

const RESULT: CaseResult = {
  caseId: "c1",
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: [],
};

const serviceJob: AgentJob = {
  evalCase,
  harness: { id: "bu", version: "1.0.0" },
  harnessSpec: {
    kind: "service",
    id: "bu",
    version: "1.0.0",
    services: [],
    dependencies: [],
    frontDoor: { service: "agent-server", submit: "POST /runs" },
    traceSource: { kind: "mlflow", endpoint: "http://mlflow:5000" },
  },
};

const processJob: AgentJob = { evalCase, harness: { id: "claude-code", version: "1.0.0" } };

describe("runLeasedJob — 하니스 kind 분기", () => {
  it("service 하니스는 runService(로컬 Docker 토폴로지) 경로로 간다", async () => {
    const runService = vi.fn(async () => RESULT);
    const runProcess = vi.fn(async () => RESULT);
    await runLeasedJob(serviceJob, { runService, runProcess });
    expect(runService).toHaveBeenCalledOnce();
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("process/command 하니스는 runProcess(runAgentJob) 경로로 간다", async () => {
    const runService = vi.fn(async () => RESULT);
    const runProcess = vi.fn(async () => RESULT);
    await runLeasedJob(processJob, { runService, runProcess });
    expect(runProcess).toHaveBeenCalledOnce();
    expect(runService).not.toHaveBeenCalled();
  });

  it("harnessSpec 없으면 process 경로(현행) — service 만 토폴로지", async () => {
    const runService = vi.fn(async () => RESULT);
    const runProcess = vi.fn(async () => RESULT);
    await runLeasedJob({ ...serviceJob, harnessSpec: undefined }, { runService, runProcess });
    expect(runProcess).toHaveBeenCalledOnce();
    expect(runService).not.toHaveBeenCalled();
  });
});

// 회귀: 케이스마다 새 런타임을 만들면 warm-pool 이 매번 비어 토폴로지를 재배포 → 고정 이름 컨테이너 충돌.
// 러너 프로세스 내 lazy 싱글톤으로 런타임을 재사용해야 warm-pool 이 케이스 간 유지된다.
describe("sharedTopologyRuntime — 러너 프로세스 내 lazy 싱글톤", () => {
  const fakeRuntime = (): TopologyRuntime => ({ id: "docker" }) as unknown as TopologyRuntime;

  it("여러 번 호출해도 런타임을 한 번만 만들어 같은 인스턴스를 재사용한다", () => {
    resetSharedTopologyRuntime();
    const made = fakeRuntime();
    const make = vi.fn(() => made);
    const first = sharedTopologyRuntime(undefined, make);
    const second = sharedTopologyRuntime(undefined, make);
    expect(make).toHaveBeenCalledOnce(); // 케이스마다 재생성하지 않는다(토폴로지 1회 배포)
    expect(first).toBe(second);
    expect(first).toBe(made);
  });

  it("reset 후 다음 호출은 새 런타임을 만든다(러너 재기동)", () => {
    resetSharedTopologyRuntime();
    const make = vi.fn(() => fakeRuntime());
    const first = sharedTopologyRuntime(undefined, make);
    resetSharedTopologyRuntime();
    const second = sharedTopologyRuntime(undefined, make);
    expect(make).toHaveBeenCalledTimes(2);
    expect(first).not.toBe(second);
  });
});
