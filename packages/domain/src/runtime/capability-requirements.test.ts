import type { CaseJob, EvalCase, RuntimeSpec, ServiceHarnessSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  computeNeedsFor,
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

  it("derives the case's declared os as a placement capability — windows/macos gate BEFORE dispatch", () => {
    // Regression: placement.os never entered the capability set, so a windows-declaring case sailed through
    // every placement gate and was refused only by the driver inside the job — a wasted dispatch round-trip
    // for an answer the gate had at submit.
    expect(requiredCapabilities(base({ placement: { os: "windows" } }))).toContain("os-windows");
    expect(requiredCapabilities(base({ placement: { os: "macos" } }))).toContain("os-macos");
    // linux is the implicit default world — no capability, no gate.
    expect(requiredCapabilities(base({ placement: { os: "linux" } }))).toEqual([]);
    expect(requiredCapabilities(base({}))).toEqual([]);
  });
});

describe("computeNeedsFor — the driver lane's world declaration, derived from the env kind", () => {
  it("repo/prompt → shell; browser adds browser; os-use adds desktop", () => {
    expect(computeNeedsFor(base({}))).toEqual(["shell"]);
    expect(computeNeedsFor(base({ env: { kind: "prompt" } }))).toEqual(["shell"]);
    expect(computeNeedsFor(base({ env: { kind: "browser" } }))).toEqual(["shell", "browser"]);
    expect(computeNeedsFor(base({ env: { kind: "os-use" } }))).toEqual(["shell", "desktop"]);
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
  const job = (over: Partial<CaseJob>): CaseJob => ({
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

  it("a service harness does NOT require the case-env caps the topology itself provides (browser case ≠ browser runtime)", () => {
    // Given a browser-env case dispatched to a topology harness — the topology provisions the per-case browser,
    // so requiring "browser" of the RUNTIME (pre-fix) rejected every browser case on every topology runtime and
    // contradicted the submit-time gate (requiredCapabilitiesForHarness).
    const browserJob = job({ evalCase: base({ env: { kind: "browser" } }), harnessSpec: topo([svc("hub")]) });
    expect(requiredCapabilitiesForJob(browserJob)).toEqual(["docker"]);
    // The dispatch-time set equals the submit-time set for the same harness — no gate contradiction.
    expect(requiredCapabilitiesForJob(browserJob).sort()).toEqual(
      requiredCapabilitiesForHarness(topo([svc("hub")])).sort(),
    );
  });

  it("a pure host-exec Windows topology needs os-windows but NOT docker (Windows-without-Docker placement)", () => {
    // Pre-fix `docker` was unconditional for service harnesses, so `requires.os: windows` was satisfiable
    // only by a docker-capable Windows node — an otherwise-fine native service could never place.
    const host: ServiceHarnessSpec["services"][number] = {
      name: "win-ui",
      needs: [],
      perRun: [],
      replicas: 1,
      env: {},
      requires: { os: "windows" },
      exec: { kind: "host", command: ["C:/drivers/ui-driver.exe"] },
    };
    expect(requiredCapabilitiesForHarness(topo([host]))).toEqual(["os-windows"]);
    expect(requiredCapabilitiesForJob(job({ harnessSpec: topo([host]) }))).toEqual(["os-windows"]);
    // A mixed topology (any containerized peer) still needs docker.
    expect(requiredCapabilitiesForHarness(topo([svc("hub"), host])).sort()).toEqual(["docker", "os-windows"]);
  });

  it("a service harness keeps the case's isolation ask — sandbox is a runtime property, not topology-provided", () => {
    const isolated = job({
      evalCase: base({ env: { kind: "browser" }, placement: { isolation: "gvisor" } }),
      harnessSpec: topo([svc("hub")]),
    });
    expect(requiredCapabilitiesForJob(isolated).sort()).toEqual(["docker", "sandbox"]);
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

  it("a command harness declaring resources.gpu requires the gpu capability (portable resource ask, like cpu/mem)", () => {
    const cmd = {
      kind: "command" as const,
      id: "cuda",
      version: "1.0.0",
      setup: [],
      command: "run",
      env: {},
      params: {},
      trace: { kind: "none" as const },
      resources: { gpu: 2 },
    };
    expect(requiredCapabilitiesForJob(job({ harnessSpec: cmd }))).toContain("gpu");
    expect(requiredCapabilitiesForHarness(cmd)).toEqual(["gpu"]);
    // no gpu declared → no gpu gate (cpu/mem alone don't add it)
    expect(requiredCapabilitiesForHarness({ ...cmd, resources: { cpu: 500 } })).toEqual([]);
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

  it("a gpu binding on the spec advertises the gpu capability", () => {
    expect(defaultRuntimeCapabilities(rt({ kind: "k8s", image: "x", gpu: 2 })).sort()).toEqual(["docker", "gpu"]);
    expect(defaultRuntimeCapabilities(rt({ kind: "k8s", image: "x" }))).not.toContain("gpu");
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

// An unresolved environment REFERENCE is not a case with a modest world (world-and-engagement-model.md). The
// control plane resolves it before anything is placed; one arriving here means the resolution was skipped,
// and the fall-through would derive the DEFAULT box — an under-provisioned run that reads as an agent failing
// a task it was never given the world for.
describe("a world nobody resolved is refused, not defaulted", () => {
  const referencing = { id: "c1", env: { kind: "ref", id: "shop" }, graders: [], timeoutSec: 60, tags: [] };
  it("refuses to derive capabilities or compute needs from a reference", () => {
    expect(() => requiredCapabilities(referencing as never)).toThrow(/never resolved/);
    expect(() => computeNeedsFor(referencing as never)).toThrow(/never resolved/);
  });
  it("still answers for a resolved world", () => {
    expect(computeNeedsFor({ env: { kind: "browser" } } as never)).toEqual(["shell", "browser"]);
  });
});
