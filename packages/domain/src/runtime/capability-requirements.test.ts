import type { AgentJob, EvalCase, RuntimeSpec, ServiceHarnessSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  defaultRuntimeCapabilities,
  requiredCapabilities,
  requiredCapabilitiesForHarness,
  requiredCapabilitiesForJob,
  requiredCapabilitiesForTopology,
  runtimeSpecWithCapabilities,
} from "./capability-requirements.js";

const base = (over: Partial<EvalCase>): EvalCase => ({
  id: "c",
  env: { kind: "repo", source: { files: {} } },
  task: "t",
  graders: [],
  timeoutSec: 60,
  tags: [],
  ...over,
});

describe("requiredCapabilities — derive execution requirements from the case (routed per kind)", () => {
  it("adds docker (functional) when image is present, omits it otherwise", () => {
    expect(requiredCapabilities(base({ image: "img:v1" }))).toContain("docker");
    expect(requiredCapabilities(base({}))).not.toContain("docker");
  });

  it("repo: files/path sources don't need git, only a remote git source does", () => {
    expect(requiredCapabilities(base({ env: { kind: "repo", source: { files: {} } } }))).not.toContain("git");
    expect(
      requiredCapabilities(base({ env: { kind: "repo", source: { git: "https://x/r.git", ref: "main" } } })),
    ).toContain("git");
  });

  it("browser → browser, os-use → computer-use, prompt → none", () => {
    expect(requiredCapabilities(base({ env: { kind: "browser" } }))).toEqual(["browser"]);
    expect(requiredCapabilities(base({ env: { kind: "os-use" } }))).toEqual(["computer-use"]);
    expect(requiredCapabilities(base({ env: { kind: "prompt" } }))).toEqual([]);
  });

  it("adds sandbox when placement.isolation is set (security — enforced by trust-zone)", () => {
    expect(requiredCapabilities(base({ placement: { isolation: "gvisor" } }))).toContain("sandbox");
  });
});

describe("requiredCapabilitiesForTopology — heterogeneous placement (service OS → capability)", () => {
  const svc = (name: string, os?: "linux" | "windows" | "macos"): ServiceHarnessSpec["services"][number] => ({
    name,
    image: `${name}:1`,
    needs: [],
    perRun: [],
    replicas: 1,
    env: {},
    ...(os ? { requires: { os } } : {}),
  });
  const topo = (services: ServiceHarnessSpec["services"]): ServiceHarnessSpec => ({
    kind: "service",
    id: "t",
    version: "1.0.0",
    services,
    dependencies: [],
    frontDoor: { service: services[0]?.name ?? "s", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: "http://x" },
  });

  it("a Windows service requires os-windows; linux/unset services add no gate", () => {
    expect(requiredCapabilitiesForTopology(topo([svc("agent"), svc("pw", "windows")]))).toEqual(["os-windows"]);
    expect(requiredCapabilitiesForTopology(topo([svc("agent"), svc("db", "linux")]))).toEqual([]);
    expect(requiredCapabilitiesForTopology(topo([svc("agent")]))).toEqual([]);
  });

  it("maps macos and dedupes repeated OS requirements", () => {
    expect(requiredCapabilitiesForTopology(topo([svc("a", "macos")]))).toEqual(["os-macos"]);
    expect(requiredCapabilitiesForTopology(topo([svc("a", "windows"), svc("b", "windows")]))).toEqual(["os-windows"]);
  });
});

describe("requiredCapabilitiesForJob — case ∪ topology (the shared placement-gate input)", () => {
  const svc = (name: string, os?: "linux" | "windows" | "macos"): ServiceHarnessSpec["services"][number] => ({
    name,
    image: `${name}:1`,
    needs: [],
    perRun: [],
    replicas: 1,
    env: {},
    ...(os ? { requires: { os } } : {}),
  });
  const topo = (services: ServiceHarnessSpec["services"]): ServiceHarnessSpec => ({
    kind: "service",
    id: "grid",
    version: "1.0.0",
    services,
    dependencies: [],
    frontDoor: { service: services[0]?.name ?? "s", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: "http://x" },
  });
  const job = (over: Partial<AgentJob>): AgentJob => ({
    evalCase: base({}),
    harness: { id: "h", version: "1.0.0" },
    ...over,
  });

  it("a plain (non-topology) job → just its case caps", () => {
    expect(requiredCapabilitiesForJob(job({ evalCase: base({ image: "x:1" }) }))).toEqual(["docker"]);
    expect(requiredCapabilitiesForJob(job({}))).toEqual([]); // repo/files case → nothing
  });

  it("a service harness adds docker; a Windows service also adds os-windows (the gate input)", () => {
    expect(requiredCapabilitiesForJob(job({ harnessSpec: topo([svc("hub")]) }))).toEqual(["docker"]); // linux topology → docker only
    expect(requiredCapabilitiesForJob(job({ harnessSpec: topo([svc("hub"), svc("win", "windows")]) })).sort()).toEqual([
      "docker",
      "os-windows",
    ]);
  });

  it("requiredCapabilitiesForHarness — the submit-time (case-independent) input", () => {
    expect(requiredCapabilitiesForHarness(topo([svc("hub")]))).toEqual(["docker"]); // linux topology
    expect(requiredCapabilitiesForHarness(topo([svc("hub"), svc("win", "windows")])).sort()).toEqual([
      "docker",
      "os-windows",
    ]);
    // a non-topology (process/command) harness declares nothing at submit — case-level caps gate at dispatch.
    expect(requiredCapabilitiesForHarness({ kind: "process", id: "cli", version: "1" })).toEqual([]);
  });
});

describe("defaultRuntimeCapabilities — auto-label what a registered runtime provides", () => {
  const rt = (over: Partial<RuntimeSpec> & { kind: RuntimeSpec["kind"] }): RuntimeSpec =>
    ({ id: "a", version: "1.0.0", tags: [], ...over }) as RuntimeSpec;

  it("nomad/k8s → docker; hardened runtime → sandbox; traceSource → topology; local → none", () => {
    expect(defaultRuntimeCapabilities(rt({ kind: "k8s", image: "x" }))).toEqual(["docker"]);
    expect(defaultRuntimeCapabilities(rt({ kind: "k8s", image: "x", runtimeClass: "gvisor" })).sort()).toEqual([
      "docker",
      "sandbox",
    ]);
    expect(defaultRuntimeCapabilities(rt({ kind: "k8s", image: "x", runtimeClass: "runc" }))).toEqual(["docker"]); // runc is not hardened
    expect(
      defaultRuntimeCapabilities(
        rt({ kind: "nomad", addr: "http://x:4646", image: "x", traceSource: { kind: "otel", endpoint: "e" } }),
      ).sort(),
    ).toEqual(["docker", "topology"]);
    expect(defaultRuntimeCapabilities(rt({ kind: "local" }))).toEqual([]);
  });
});

describe("runtimeSpecWithCapabilities — the register-time SSOT (declared ∪ derived)", () => {
  const rt = (over: Partial<RuntimeSpec> & { kind: RuntimeSpec["kind"] }): RuntimeSpec =>
    ({ id: "a", version: "1.0.0", tags: [], ...over }) as RuntimeSpec;

  it("fills the auto-derived capabilities when the spec declares none", () => {
    const filled = runtimeSpecWithCapabilities(rt({ kind: "k8s", image: "x", runtimeClass: "gvisor" }));
    expect([...(filled.capabilities ?? [])].sort()).toEqual(["docker", "sandbox"]);
  });

  it("keeps operator-declared capabilities the spec can't derive (os-windows) and unions them with the derived set", () => {
    const filled = runtimeSpecWithCapabilities(rt({ kind: "k8s", image: "x", capabilities: ["os-windows"] }));
    expect([...(filled.capabilities ?? [])].sort()).toEqual(["docker", "os-windows"]);
  });

  it("is idempotent — re-running on a filled spec adds nothing new", () => {
    const once = runtimeSpecWithCapabilities(rt({ kind: "nomad", addr: "http://x:4646", image: "x" }));
    const twice = runtimeSpecWithCapabilities(once);
    expect(twice.capabilities).toEqual(once.capabilities);
  });
});
