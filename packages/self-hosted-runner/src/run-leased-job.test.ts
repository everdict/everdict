import type { CaseJob, CaseResult } from "@everdict/contracts";
import type { TopologyRuntime } from "@everdict/topology";
import { describe, expect, it, vi } from "vitest";
import {
  resetSharedTopologyRuntime,
  runLeasedJob,
  sharedTopologyRuntime,
  workspaceImagesToPull,
} from "./run-leased-job.js";

const evalCase: CaseJob["evalCase"] = {
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

const serviceJob: CaseJob = {
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

const processJob: CaseJob = { evalCase, harness: { id: "claude-code", version: "1.0.0" } };

describe("runLeasedJob — harness kind branching", () => {
  it("a service harness goes down the runService (local Docker topology) path", async () => {
    const runService = vi.fn(async () => RESULT);
    const runProcess = vi.fn(async () => RESULT);
    await runLeasedJob(serviceJob, { runService, runProcess });
    expect(runService).toHaveBeenCalledOnce();
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("a process/command harness goes down the runProcess (runCaseJob) path", async () => {
    const runService = vi.fn(async () => RESULT);
    const runProcess = vi.fn(async () => RESULT);
    await runLeasedJob(processJob, { runService, runProcess });
    expect(runProcess).toHaveBeenCalledOnce();
    expect(runService).not.toHaveBeenCalled();
  });

  it("with no harnessSpec, the process path (current) — only service is topology", async () => {
    const runService = vi.fn(async () => RESULT);
    const runProcess = vi.fn(async () => RESULT);
    await runLeasedJob({ ...serviceJob, harnessSpec: undefined }, { runService, runProcess });
    expect(runProcess).toHaveBeenCalledOnce();
    expect(runService).not.toHaveBeenCalled();
  });
});

// Workspace-registry service images: authenticated pre-pull (temporary DOCKER_CONFIG) before deploy — pin overrides applied, host-match only.
describe("runLeasedJob — workspace-registry pre-pull (service)", () => {
  const AUTH = { host: "ghcr.io", username: "bot", password: "pull-tok" };
  const spec: NonNullable<CaseJob["harnessSpec"]> = {
    kind: "service",
    id: "bu",
    version: "1.0.0",
    services: [
      { name: "agent", image: "ghcr.io/acme/agent:v1", needs: [], perRun: [], replicas: 1, env: {} },
      { name: "echo", image: "mendhak/http-https-echo:latest", needs: [], perRun: [], replicas: 1, env: {} },
    ],
    dependencies: [],
    frontDoor: { service: "agent", submit: "POST /runs" },
    traceSource: { kind: "mlflow", endpoint: "http://mlflow:5000" },
  };

  it("with registryAuth, pre-pull only host-matching images then go to runService", async () => {
    const pulled: string[] = [];
    const runService = vi.fn(async () => RESULT);
    await runLeasedJob(
      { evalCase, harness: { id: "bu", version: "1.0.0" }, harnessSpec: spec, registryAuth: AUTH },
      { runService, pullImage: async (image) => void pulled.push(image) },
    );
    expect(pulled).toEqual(["ghcr.io/acme/agent:v1"]); // echo (docker.io) isn't a pull target
    expect(runService).toHaveBeenCalledOnce();
  });

  it("workspaceImagesToPull — applies per-dispatch pin overrides and dedupes", () => {
    expect(workspaceImagesToPull(spec, { echo: "ghcr.io/acme/echo:pr-1" }, AUTH)).toEqual([
      "ghcr.io/acme/agent:v1",
      "ghcr.io/acme/echo:pr-1",
    ]);
    expect(workspaceImagesToPull(spec, undefined, { host: "quay.io", password: "p" })).toEqual([]);
  });

  it("with no registryAuth, no pre-pull, as-is (no regression from current)", async () => {
    const pullImage = vi.fn(async () => {});
    const runService = vi.fn(async () => RESULT);
    await runLeasedJob(
      { evalCase, harness: { id: "bu", version: "1.0.0" }, harnessSpec: spec },
      { runService, pullImage },
    );
    expect(pullImage).not.toHaveBeenCalled();
  });
});

// Portability contract: a non-service case that declares case.image runs in that image's container (containerize) when the runner has Docker
// → "one definition, same environment whether managed or local". Design: docs/architecture/portable-harness-runtime.md.
describe("runLeasedJob — case.image container execution (portability)", () => {
  const imageJob: CaseJob = {
    evalCase: { ...evalCase, image: "spreadsheetbench:v1" },
    harness: { id: "codex", version: "1.0.0" },
  };

  it("image declared + Docker present → container execution (containerize:true)", async () => {
    const runProcess = vi.fn(async () => RESULT);
    await runLeasedJob(imageJob, { runProcess, dockerAvailable: true });
    expect(runProcess).toHaveBeenCalledWith(imageJob, { containerize: true });
  });

  it("image declared + no Docker → host-native (containerize:false) + reason logged", async () => {
    const runProcess = vi.fn(async () => RESULT);
    const log = vi.fn();
    await runLeasedJob(imageJob, { runProcess, dockerAvailable: false, log });
    expect(runProcess).toHaveBeenCalledWith(imageJob, { containerize: false });
    expect(log).toHaveBeenCalledOnce(); // no silent failure — announces that an image is required but Docker is absent
    expect(String(log.mock.calls[0]?.[0])).toContain("spreadsheetbench:v1");
  });

  it("no image → host-native even if Docker is present (containerize:false)", async () => {
    const runProcess = vi.fn(async () => RESULT);
    const log = vi.fn();
    await runLeasedJob(processJob, { runProcess, dockerAvailable: true, log });
    expect(runProcess).toHaveBeenCalledWith(processJob, { containerize: false });
    expect(log).not.toHaveBeenCalled(); // nothing to announce when no image is declared
  });

  it("when containerizing, pass the runner mounts (codex login etc.) into the container", async () => {
    const runProcess = vi.fn(async () => RESULT);
    const mounts = [{ source: "/home/u/.codex", target: "/codex" }];
    await runLeasedJob(imageJob, { runProcess, dockerAvailable: true, mounts });
    expect(runProcess).toHaveBeenCalledWith(imageJob, { containerize: true, mounts });
  });

  it("host-native (not containerizing) passes no mounts (no mount concept)", async () => {
    const runProcess = vi.fn(async () => RESULT);
    const mounts = [{ source: "/home/u/.codex", target: "/codex" }];
    await runLeasedJob(processJob, { runProcess, dockerAvailable: true, mounts }); // no image → containerize false
    expect(runProcess).toHaveBeenCalledWith(processJob, { containerize: false });
  });
});

// Regression: creating a new runtime per case leaves the warm-pool empty each time and redeploys the topology → fixed-name container collision.
// Reusing the runtime via a lazy singleton within the runner process is what keeps the warm-pool across cases.
describe("sharedTopologyRuntime — lazy singleton within the runner process", () => {
  const fakeRuntime = (): TopologyRuntime => ({ id: "docker" }) as unknown as TopologyRuntime;

  it("creates the runtime only once across multiple calls and reuses the same instance", () => {
    resetSharedTopologyRuntime();
    const made = fakeRuntime();
    const make = vi.fn(() => made);
    const first = sharedTopologyRuntime(undefined, make);
    const second = sharedTopologyRuntime(undefined, make);
    expect(make).toHaveBeenCalledOnce(); // not recreated per case (topology deployed once)
    expect(first).toBe(second);
    expect(first).toBe(made);
  });

  it("the next call after reset creates a new runtime (runner restart)", () => {
    resetSharedTopologyRuntime();
    const make = vi.fn(() => fakeRuntime());
    const first = sharedTopologyRuntime(undefined, make);
    resetSharedTopologyRuntime();
    const second = sharedTopologyRuntime(undefined, make);
    expect(make).toHaveBeenCalledTimes(2);
    expect(first).not.toBe(second);
  });
});
