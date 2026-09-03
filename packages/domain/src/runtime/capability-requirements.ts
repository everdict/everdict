import type {
  CapabilityName,
  CaseJob,
  EvalCase,
  HarnessSpec,
  PlacementOs,
  RuntimeSpec,
  ServiceHarnessSpec,
} from "@everdict/contracts";
import { BadRequestError, resolvePlacementOs } from "@everdict/contracts";
import { isHardenedRuntime } from "./trust-zone-hardening.js";

// Derive the capabilities a case requires to run — decided from case fields (image/env.kind/source/placement.isolation).
// These flow to per-kind enforcement layers: functional → placement gate (functionalGate) · security (sandbox) → trust-zone.
// An auth (login) requirement comes from runtime/harness selection, not the case, so it is not derived here (that layer handles it).
// Design: docs/architecture/self-hosted-runtime-and-runners.md.
export function requiredCapabilities(evalCase: EvalCase): CapabilityName[] {
  const req = new Set<CapabilityName>();
  if (evalCase.image) req.add("docker"); // container image execution (case.image)
  const env = evalCase.env;
  // A REFERENCE is resolved by the control plane before anything is placed (world-and-engagement-model.md).
  // One reaching here means the resolution was skipped, and the else-branch below would derive the DEFAULT
  // box for a case whose world nobody read — an under-provisioned run that reads as an agent that failed.
  if (env.kind === "ref") throw unresolvedEnvironment(evalCase.id, env.id);
  if (env.kind === "repo") {
    if ("git" in env.source) req.add("git"); // only a remote git source needs git (files/path sources don't)
  } else if (env.kind === "browser") {
    req.add("browser"); // Playwright browser
  } else if (env.kind === "os-use") {
    req.add("computer-use"); // OS GUI control
  }
  if (evalCase.placement?.isolation) req.add("sandbox"); // isolation requirement (security — enforced by trust-zone)
  // The case's DECLARED world (placement.os) is a placement requirement like any other — deriving it here puts
  // it in front of the SAME pre-placement gates (runtimeSatisfies / the runner hub) every capability uses.
  // Before this, a windows-declaring case sailed through placement and was refused only by the driver deep
  // inside the job — a full dispatch round-trip to learn what the gate could have said for free.
  const osCap = osCapability(evalCase.placement?.os);
  if (osCap) req.add(osCap);
  return [...req];
}

// ── Compute needs (the DRIVER lane's world declaration) ─────────────────────────────────────────────────
// What a case's compute must offer, derived from the environment kind — the ComputeSpec.needs the driver
// receives. Distinct from the placement-capability vocabulary above: capabilities gate WHERE a job may be
// placed; needs tell the provisioned compute what world the case is about to act on. "browser" flows through
// to the driver (a container IMAGE can provide headless chromium — the driver cannot know, so it must not
// refuse); "desktop" is a world no process/container driver can conjure and is refused pre-flight there.
export function computeNeedsFor(evalCase: Pick<EvalCase, "env">): Array<"shell" | "browser" | "desktop"> {
  // Same refusal as `requiredCapabilities`, and for the same reason: `["shell"]` for an unresolved reference
  // provisions a box with no browser and no desktop for a case whose world was never read.
  if (evalCase.env.kind === "ref") throw unresolvedEnvironment("", evalCase.env.id);
  if (evalCase.env.kind === "browser") return ["shell", "browser"];
  if (evalCase.env.kind === "os-use") return ["shell", "desktop"];
  return ["shell"];
}

// Map a service's intrinsic OS need to its placement capability. linux is the implicit default (no capability, no
// gate), so it — and an unset os — derive nothing.
// The resolution goes through resolvePlacementOs, the same function the drivers provision under and the execution
// manifest records: the gate and the world a case lands in must be answering from one definition. Behavior is
// unchanged — an unset os resolves to linux, and linux (declared or defaulted) still derives no capability,
// deliberately: linux is the world every runtime is assumed to offer, so gating on it would gate on everything.
function osCapability(os: PlacementOs | undefined): CapabilityName | undefined {
  const { os: world } = resolvePlacementOs({ os });
  if (world === "windows") return "os-windows";
  if (world === "macos") return "os-macos";
  return undefined;
}

// Derive the placement capabilities a service topology requires from its services' intrinsic OS needs — the
// heterogeneous-placement axis. A Windows service → os-windows, so functionalGate excludes runtimes whose node pool
// has no Windows node (shown grey in the web). Infra-agnostic: the harness declares WHAT (os), each TopologyRuntime
// realizes WHERE natively. Unioned by the caller with the run's other requirements (docker/topology/…).
// Pure/deterministic. Design: docs/architecture/heterogeneous-topology-placement.md.
export function requiredCapabilitiesForTopology(spec: ServiceHarnessSpec): CapabilityName[] {
  const req = new Set<CapabilityName>();
  for (const svc of spec.services) {
    const cap = osCapability(svc.requires?.os);
    if (cap) req.add(cap);
  }
  return [...req];
}

// Does this harness need a GPU? A portable resource ask (resources.gpu, like cpu/mem) — NOT a node-class/pool, which
// stays runtime-owned. Drives the `gpu` functional capability so a gpu harness is gated to a gpu-capable runtime.
function harnessNeedsGpu(spec: HarnessSpec): boolean {
  if (spec.kind === "command") return (spec.resources?.gpu ?? 0) > 0;
  if (spec.kind === "service") return spec.services.some((s) => (s.resources?.gpu ?? 0) > 0);
  return false;
}

// Does this topology stand up any CONTAINER? A host-exec service (exec.kind "host" — runs directly on the node,
// Nomad raw_exec) needs no container runtime, so a pure-host topology (e.g. a native Windows UI driver) gates on its
// OS capability alone. Pre-fix `docker` was unconditional, so `requires.os: windows` was satisfiable only by a
// docker-capable Windows node — an otherwise-fine native service could never place.
export function topologyNeedsDocker(spec: ServiceHarnessSpec): boolean {
  return spec.services.some((s) => s.exec?.kind !== "host");
}

// The full set of capabilities a JOB requires — the single "what does this job need" function the placement gates
// use: the registered-runtime dispatcher (runtimeSatisfies vs RuntimeSpec.capabilities) and the self-hosted runner
// hub (vs a runner's probed capabilities) — so both reject a job a target can't run BEFORE placing it (e.g. a
// Windows-service topology on a Linux-only target, which would otherwise sit constraint-filtered / pending forever).
//
// For a service/topology harness the CASE-ENV capabilities are deliberately NOT merged in: the topology PROVIDES the
// case environment itself — the per-case browser comes from provisionBrowserEnv / a declared session service, and
// repo files ride the front-door request. Merging them (the pre-fix behavior) contradicted the submit-time gate
// (requiredCapabilitiesForHarness, which never asks for case caps) and made every topology runtime reject browser
// cases outright, since no runtime advertises "browser". The runtime keeps only what IT must provide: docker + the
// services' intrinsic OS + gpu (= the harness gate) + the case's isolation ask (sandbox IS a runtime property).
// Pure. Design: docs/architecture/heterogeneous-topology-placement.md.
export function requiredCapabilitiesForJob(job: CaseJob): CapabilityName[] {
  if (job.harnessSpec?.kind === "service") {
    const caps = new Set<CapabilityName>(requiredCapabilitiesForHarness(job.harnessSpec));
    if (job.evalCase.placement?.isolation) caps.add("sandbox");
    return [...caps];
  }
  const caps = new Set<CapabilityName>(requiredCapabilities(job.evalCase));
  if (job.harnessSpec && harnessNeedsGpu(job.harnessSpec)) caps.add("gpu"); // resources.gpu → a gpu-capable runtime
  return [...caps];
}

// The capabilities a HARNESS requires independent of any single case — the submit-time placement-gate input (a run
// can be rejected the instant it's submitted, before any case is dispatched). A service/topology harness needs docker
// + its services' OS caps; a process/command harness declares none here (its case-level needs are gated at dispatch).
// Pure. Design: docs/architecture/heterogeneous-topology-placement.md.
export function requiredCapabilitiesForHarness(spec: HarnessSpec): CapabilityName[] {
  const caps = new Set<CapabilityName>();
  if (harnessNeedsGpu(spec)) caps.add("gpu"); // a GPU-needing harness gates to a gpu-capable runtime at submit time
  if (spec.kind === "service") {
    if (topologyNeedsDocker(spec)) caps.add("docker"); // only a containerized service needs a container runtime
    for (const c of requiredCapabilitiesForTopology(spec)) caps.add(c);
  }
  return [...caps];
}

// Derive the capabilities a registered runtime "provides" by default — the app auto-labels from the spec (like the runner's
// detectCapabilities, instead of manual user input). nomad/k8s run container images (docker); an isolation runtime (runsc/kata etc.) → sandbox;
// with traceSource, topology (service harness hosting). local is in-process (none). The counterpart of requiredCapabilities — filled at
// register time and used to match runtimeSatisfies (provided) vs requiredCapabilities (required). Design: docs/architecture/self-hosted-runtime-and-runners.md.
export function defaultRuntimeCapabilities(spec: RuntimeSpec): CapabilityName[] {
  const caps = new Set<CapabilityName>();
  if (spec.kind === "nomad" || spec.kind === "k8s") {
    caps.add("docker"); // the cluster runs container images
    const isolationRuntime = spec.kind === "nomad" ? spec.runtime : spec.runtimeClass;
    if (isolationRuntime && isHardenedRuntime(isolationRuntime)) caps.add("sandbox");
    if (spec.traceSource) caps.add("topology"); // traceSource = topology-capable
    if (spec.gpu !== undefined) caps.add("gpu"); // a GPU binding (reserve N GPUs) → advertise the gpu capability
  }
  return [...caps];
}

// The register-time SSOT for a runtime's capabilities: the auto-derived set UNION any the operator explicitly
// declared (e.g. os-windows/os-macos, which can't be inferred from the spec). Filling this server-side keeps the
// hardened-runtime set from being recomputed in every client (the web wizard used to duplicate isHardenedRuntime).
// Idempotent — re-running on a filled spec adds nothing new.
export function runtimeSpecWithCapabilities(spec: RuntimeSpec): RuntimeSpec {
  const merged = new Set<CapabilityName>([...defaultRuntimeCapabilities(spec), ...(spec.capabilities ?? [])]);
  return { ...spec, capabilities: [...merged] };
}

// ── ONE RUNTIME SERVES TWO JOB SHAPES ────────────────────────────────────────────────────────────────
//
// Placement is independent of what is placed — that is the architecture's own line between a Backend and a
// Driver. But the tenant-runtime path picked its backend from the RUNTIME's shape alone: a nomad/k8s runtime
// carrying a traceSource became a topology deployer for EVERY job routed to it. A cluster legitimately serves
// two shapes at once: a `kind:"service"` harness needs the topology deployer, and a plain process/command job
// on the same cluster needs the ordinary compute backend.
//
// A CO-LOCATED CODE JUDGE is exactly the second one. It dispatches a no-op `command` harness beside the case
// it grades, inheriting the case's runtime — and was handed the topology deployer, which looked its harness id
// up in the harness registry, missed, and failed with "harness instance not found": a judge that cannot run,
// reported as a missing registration nobody ever made.
//
// So the flavour is read off the JOB. `undefined` means the job did not say (it carries no inline spec), and
// the caller keeps its runtime-shaped default — which is what the connection probe, having no job at all,
// must also do.
export function jobFlavour(job: CaseJob): "service" | "process" | undefined {
  if (!job.harnessSpec) return undefined;
  return job.harnessSpec.kind === "service" ? "service" : "process";
}

// The one wording for "this case's world was never resolved", so the two derivations above and anything that
// joins them say the same thing.
function unresolvedEnvironment(caseId: string, environmentId: string): BadRequestError {
  return new BadRequestError(
    "BAD_REQUEST",
    { case: caseId, environment: environmentId },
    `this case names environment '${environmentId}' by reference and it was never resolved — the world it needs cannot be derived from a reference, so placing it would provision the default box for a world nobody read`,
  );
}
