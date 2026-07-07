import { type AgentJob, AppError, type RuntimeSpec, RuntimeSpecSchema } from "@everdict/core";
import type { HarnessInstanceRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { buildTopologyBackend } from "./topology-backend.js";

// topology kind 제거(5b-2) → topology-capable nomad/k8s(= traceSource 를 가진 런타임). orchestrator 는 kind 에서 암시.
const nomadSpec: Extract<RuntimeSpec, { kind: "nomad" | "k8s" }> = {
  kind: "nomad",
  id: "topo-nomad",
  version: "1.0.0",
  addr: "http://nomad.internal:4646",
  image: "ghcr.io/acme/agent:v1",
  traceSource: { kind: "otel", endpoint: "http://otel:4318" },
  tags: [],
};
const k8sSpec: Extract<RuntimeSpec, { kind: "nomad" | "k8s" }> = {
  kind: "k8s",
  id: "topo-k8s",
  version: "1.0.0",
  image: "ghcr.io/acme/agent:v1",
  context: "kind-everdict",
  traceSource: { kind: "mlflow", endpoint: "http://mlflow:5000" },
  tags: [],
};

function harnessesReturning(kind: string): HarnessInstanceRegistry {
  return {
    async get() {
      return { kind, id: "h", version: "1.0.0", setup: [], command: "x", env: {}, trace: { kind: "none" } };
    },
  } as unknown as HarnessInstanceRegistry;
}

const job: AgentJob = {
  evalCase: { id: "c", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 1, tags: [] },
  harness: { id: "h", version: "1.0.0" },
  tenant: "acme",
};

describe("buildTopologyBackend (topology RuntimeSpec → ServiceTopologyBackend)", () => {
  it("RuntimeSpecSchema 가 topology 런타임을 검증 통과(테넌트가 POST /runtimes 로 등록 가능)", () => {
    expect(RuntimeSpecSchema.safeParse(nomadSpec).success).toBe(true);
    expect(RuntimeSpecSchema.safeParse(k8sSpec).success).toBe(true);
  });

  it("nomad orchestrator → ServiceTopologyBackend(id=service:nomad)", () => {
    const b = buildTopologyBackend(nomadSpec, { harnesses: harnessesReturning("service") });
    expect(b.id).toBe("service:nomad");
  });

  it("k8s orchestrator → ServiceTopologyBackend(id=service:k8s)", () => {
    const b = buildTopologyBackend(k8sSpec, { harnesses: harnessesReturning("service") });
    expect(b.id).toBe("service:k8s");
  });

  it("dispatch: 하니스가 kind:service 가 아니면 클러스터 접근 전에 BAD_REQUEST(specFor 거부)", async () => {
    const b = buildTopologyBackend(nomadSpec, { harnesses: harnessesReturning("command") });
    // specFor 가 dispatch 맨 앞에서 호출 → ensureTopology(클러스터) 전에 거부되므로 라이브 인프라 없이 검증 가능.
    await expect(b.dispatch(job)).rejects.toBeInstanceOf(AppError);
  });
});
