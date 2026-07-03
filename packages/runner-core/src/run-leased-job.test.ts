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

// 이식성 계약: case.image 를 선언한 비-service 케이스는, 러너에 Docker 가 있으면 그 이미지 컨테이너에서 실행(containerize)한다
// → "정의 하나가 관리형이든 로컬이든 동일 환경". 설계: docs/architecture/portable-harness-runtime.md.
describe("runLeasedJob — case.image 컨테이너 실행(이식성)", () => {
  const imageJob: AgentJob = {
    evalCase: { ...evalCase, image: "spreadsheetbench:v1" },
    harness: { id: "codex", version: "1.0.0" },
  };

  it("image 선언 + Docker 있음 → 컨테이너 실행(containerize:true)", async () => {
    const runProcess = vi.fn(async () => RESULT);
    await runLeasedJob(imageJob, { runProcess, dockerAvailable: true });
    expect(runProcess).toHaveBeenCalledWith(imageJob, { containerize: true });
  });

  it("image 선언 + Docker 없음 → 호스트-네이티브(containerize:false) + 사유 로그", async () => {
    const runProcess = vi.fn(async () => RESULT);
    const log = vi.fn();
    await runLeasedJob(imageJob, { runProcess, dockerAvailable: false, log });
    expect(runProcess).toHaveBeenCalledWith(imageJob, { containerize: false });
    expect(log).toHaveBeenCalledOnce(); // 조용한 실패 금지 — image 요구인데 Docker 없음을 알린다
    expect(String(log.mock.calls[0]?.[0])).toContain("spreadsheetbench:v1");
  });

  it("image 없음 → Docker 가 있어도 호스트-네이티브(containerize:false)", async () => {
    const runProcess = vi.fn(async () => RESULT);
    const log = vi.fn();
    await runLeasedJob(processJob, { runProcess, dockerAvailable: true, log });
    expect(runProcess).toHaveBeenCalledWith(processJob, { containerize: false });
    expect(log).not.toHaveBeenCalled(); // image 미선언이면 알릴 것도 없음
  });

  it("containerize 시 러너 mounts(codex 로그인 등)를 컨테이너로 넘긴다", async () => {
    const runProcess = vi.fn(async () => RESULT);
    const mounts = [{ source: "/home/u/.codex", target: "/codex" }];
    await runLeasedJob(imageJob, { runProcess, dockerAvailable: true, mounts });
    expect(runProcess).toHaveBeenCalledWith(imageJob, { containerize: true, mounts });
  });

  it("호스트-네이티브(containerize 아님)면 mounts 를 넘기지 않는다(마운트 개념 없음)", async () => {
    const runProcess = vi.fn(async () => RESULT);
    const mounts = [{ source: "/home/u/.codex", target: "/codex" }];
    await runLeasedJob(processJob, { runProcess, dockerAvailable: true, mounts }); // image 없음 → containerize false
    expect(runProcess).toHaveBeenCalledWith(processJob, { containerize: false });
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
