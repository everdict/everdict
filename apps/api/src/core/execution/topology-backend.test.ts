import { isScreenCapturable } from "@everdict/backends";
import { AppError, type CaseJob, type RuntimeSpec, RuntimeSpecSchema } from "@everdict/contracts";
import type { HarnessInstanceRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { buildTopologyBackend, buildTopologyEnvironment } from "./topology-backend.js";

// topology kind removed (5b-2) → topology-capable nomad/k8s (= a runtime that has a traceSource). The orchestrator is implied by the kind.
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

const job: CaseJob = {
  evalCase: { id: "c", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 1, tags: [] },
  harness: { id: "h", version: "1.0.0" },
  tenant: "acme",
};

describe("buildTopologyBackend (topology RuntimeSpec → ServiceTopologyBackend)", () => {
  it("RuntimeSpecSchema validates the topology runtime (a tenant can register it via POST /runtimes)", () => {
    expect(RuntimeSpecSchema.safeParse(nomadSpec).success).toBe(true);
    expect(RuntimeSpecSchema.safeParse(k8sSpec).success).toBe(true);
  });

  it("threads hostGatewayAddr from the RuntimeSpec into BOTH topology runtimes (regression: the knob existed on the runtime but a registered runtime could never set it — every alloc on a keyword-rejecting Nomad failed)", () => {
    const withGateway = { ...nomadSpec, hostGatewayAddr: "172.17.0.1" };
    expect(RuntimeSpecSchema.parse(withGateway).hostGatewayAddr).toBe("172.17.0.1"); // pre-fix the schema stripped it
    const env = buildTopologyEnvironment(withGateway, { harnesses: harnessesReturning("service") });
    expect((env.runtime as unknown as { opts: { hostGatewayAddr?: string } }).opts.hostGatewayAddr).toBe("172.17.0.1");
    const k8sEnv = buildTopologyEnvironment(
      { ...k8sSpec, hostGatewayAddr: "172.17.0.1" },
      { harnesses: harnessesReturning("service") },
    );
    expect((k8sEnv.runtime as unknown as { opts: { hostGatewayAddr?: string } }).opts.hostGatewayAddr).toBe(
      "172.17.0.1",
    );
  });

  it("nomad orchestrator → a ScreenCapturable topology backend", () => {
    const b = buildTopologyBackend(nomadSpec, { harnesses: harnessesReturning("service") });
    expect(isScreenCapturable(b)).toBe(true); // topology backends expose a per-run browser frame
  });

  it("k8s orchestrator → a ScreenCapturable topology backend", () => {
    const b = buildTopologyBackend(k8sSpec, { harnesses: harnessesReturning("service") });
    expect(isScreenCapturable(b)).toBe(true);
  });

  it("dispatch: if the harness isn't kind:service, BAD_REQUEST before cluster access (specFor rejects)", async () => {
    const b = buildTopologyBackend(nomadSpec, { harnesses: harnessesReturning("command") });
    // specFor is called at the very front of dispatch → rejected before ensureTopology (the cluster), so it can be verified without live infra.
    await expect(b.dispatch(job)).rejects.toBeInstanceOf(AppError);
  });
});
