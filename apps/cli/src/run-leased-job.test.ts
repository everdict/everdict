import type { AgentJob, CaseResult } from "@assay/core";
import { describe, expect, it, vi } from "vitest";
import { runLeasedJob } from "./run-leased-job.js";

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
