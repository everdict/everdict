import type {
  AgentJob,
  CapabilityName,
  EvalCase,
  HarnessSpec,
  RuntimeSpec,
  ServiceHarnessSpec,
} from "@everdict/contracts";
import { isHardenedRuntime } from "./trust-zone-hardening.js";

// Derive the capabilities a case requires to run — decided from case fields (image/env.kind/source/placement.isolation).
// These flow to per-kind enforcement layers: functional → placement gate (functionalGate) · security (sandbox) → trust-zone.
// An auth (login) requirement comes from runtime/harness selection, not the case, so it is not derived here (that layer handles it).
// Design: docs/architecture/self-hosted-runtime-and-runners.md.
export function requiredCapabilities(evalCase: EvalCase): CapabilityName[] {
  const req = new Set<CapabilityName>();
  if (evalCase.image) req.add("docker"); // container image execution (case.image)
  const env = evalCase.env;
  if (env.kind === "repo") {
    if ("git" in env.source) req.add("git"); // only a remote git source needs git (files/path sources don't)
  } else if (env.kind === "browser") {
    req.add("browser"); // Playwright browser
  } else if (env.kind === "os-use") {
    req.add("computer-use"); // OS GUI control
  }
  if (evalCase.placement?.isolation) req.add("sandbox"); // isolation requirement (security — enforced by trust-zone)
  return [...req];
}

// Map a service's intrinsic OS need to its placement capability. linux is the implicit default (no capability, no
// gate), so it — and an unset os — derive nothing.
function osCapability(os: "linux" | "windows" | "macos" | undefined): CapabilityName | undefined {
  if (os === "windows") return "os-windows";
  if (os === "macos") return "os-macos";
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

// The full set of capabilities a JOB requires = its case requirements ∪ (for a service/topology harness) the
// topology's needs: docker (it stands up containers) + each service's intrinsic OS (os-windows/os-macos). This is the
// single "what does this job need" function the placement gates use — the registered-runtime dispatcher
// (runtimeSatisfies vs RuntimeSpec.capabilities) and the self-hosted runner hub (vs a runner's probed capabilities) —
// so both reject a job a target can't run BEFORE placing it (e.g. a Windows-service topology on a Linux-only target,
// which would otherwise sit constraint-filtered / pending forever). Pure. Design: docs/architecture/heterogeneous-topology-placement.md.
export function requiredCapabilitiesForJob(job: AgentJob): CapabilityName[] {
  const caps = new Set<CapabilityName>(requiredCapabilities(job.evalCase));
  if (job.harnessSpec?.kind === "service") {
    caps.add("docker"); // a topology stands up containers even when the case carries no image
    for (const c of requiredCapabilitiesForTopology(job.harnessSpec)) caps.add(c);
  }
  return [...caps];
}

// The capabilities a HARNESS requires independent of any single case — the submit-time placement-gate input (a run
// can be rejected the instant it's submitted, before any case is dispatched). A service/topology harness needs docker
// + its services' OS caps; a process/command harness declares none here (its case-level needs are gated at dispatch).
// Pure. Design: docs/architecture/heterogeneous-topology-placement.md.
export function requiredCapabilitiesForHarness(spec: HarnessSpec): CapabilityName[] {
  if (spec.kind !== "service") return [];
  return ["docker", ...requiredCapabilitiesForTopology(spec)];
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
  }
  return [...caps];
}
