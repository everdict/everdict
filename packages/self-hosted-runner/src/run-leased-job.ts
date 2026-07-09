import { type DriverMount, pullWithRegistryAuth, runAgentJob } from "@everdict/agent";
import {
  type AgentJob,
  type CaseResult,
  type RegistryAuth,
  type ServiceHarnessSpec,
  imageUsesRegistryHost,
} from "@everdict/core";
import {
  DockerTopologyRuntime,
  type DockerTopologyRuntimeOptions,
  ServiceTopologyBackend,
  type TopologyRuntime,
} from "@everdict/topology";
import { buildTraceSource } from "@everdict/trace";

// A single Docker topology runtime within the runner process (lazy singleton). Creating a new runtime per case leaves
// the warm-pool empty each time, redeploys the same topology, and fixed-name containers cascade-fail on a docker run
// --name collision (see the partial-startup cleanup comment in docker-runtime). Creating it once and reusing it keeps
// the warm-pool (per id@version) across cases, so a topology is deployed only once per version.
let sharedRuntime: TopologyRuntime | undefined;

// Lazily create and return the single runtime within the process. runtimeOptions is computed once at runner startup and is
// immutable, so it applies only to the first creation. make is the test injection point (default DockerTopologyRuntime).
export function sharedTopologyRuntime(
  opts?: DockerTopologyRuntimeOptions,
  make: (o?: DockerTopologyRuntimeOptions) => TopologyRuntime = (o) => new DockerTopologyRuntime(o),
): TopologyRuntime {
  sharedRuntime ??= make(opts);
  return sharedRuntime;
}

// Reset the singleton — for test isolation / runner restart (a runner process normally creates it only once).
export function resetSharedTopologyRuntime(): void {
  sharedRuntime = undefined;
}

// Branch a leased job by harness kind. service (topology) → local Docker topology, otherwise → runAgentJob.
// If a non-service case declares case.image and this runner has Docker, run in that image's container (DockerDriver) —
// the same path as the managed DockerBackend, so "one definition, same environment whether managed or local" holds. Otherwise host-native LocalDriver.
// Design: docs/architecture/portable-harness-runtime.md · self-hosted-service-runner.md. The branch lives in exactly one place.
export async function runLeasedJob(
  job: AgentJob,
  opts: {
    runService?: (job: AgentJob) => Promise<CaseResult>; // test injection
    runProcess?: (job: AgentJob, runOpts: { containerize?: boolean; mounts?: DriverMount[] }) => Promise<CaseResult>;
    runtimeOptions?: DockerTopologyRuntimeOptions; // service topology runtime tuning (readiness timeout etc.)
    dockerAvailable?: boolean; // whether this runner has a Docker daemon (capability) — the gate for running image-cases in a container
    mounts?: DriverMount[]; // host resources to bind into the container when containerizing (e.g. codex login) — runner opt-in
    log?: (msg: string) => void; // notify the reason (e.g. image required but no Docker) — no silent failure
    pullImage?: (image: string, auth: RegistryAuth) => Promise<void>; // test injection (default pullWithRegistryAuth)
  } = {},
): Promise<CaseResult> {
  const spec = job.harnessSpec;
  if (spec?.kind === "service") {
    // Authenticated pre-pull (temporary DOCKER_CONFIG) of workspace-registry service images before deploy — the topology runtime's
    // docker run uses the local image (the runtime interface is unchanged). Failures propagate as-is (if the pull fails, deploy can't happen either).
    if (job.registryAuth) {
      for (const image of workspaceImagesToPull(spec, job.imagePins, job.registryAuth)) {
        opts.log?.(`pulling workspace-registry image: ${image}`);
        await (opts.pullImage ?? pullWithRegistryAuth)(image, job.registryAuth);
      }
    }
    const runService = opts.runService ?? ((j: AgentJob) => defaultRunService(j, spec, opts.runtimeOptions));
    return runService(job);
  }
  // process/command. If image is declared + Docker is present, run in that image's container (toolchain bundled — same as managed). Otherwise in-process on the host.
  const image = job.evalCase.image;
  const containerize = Boolean(image && opts.dockerAvailable);
  if (image && !opts.dockerAvailable)
    opts.log?.(
      `case ${job.evalCase.id} requires image '${image}' but this runner has no Docker → host-native execution (the host must provide the toolchain).`,
    );
  // Pass host mounts only for container execution (host-native LocalDriver has no mount concept).
  return (opts.runProcess ?? runAgentJob)(job, {
    containerize,
    ...(containerize && opts.mounts?.length ? { mounts: opts.mounts } : {}),
  });
}

// The authenticated pre-pull targets (pure) — among the service images (with per-dispatch image-pin overrides applied),
// only those whose registry host matches auth.host, deduped. A pin swaps a service's image, so the pin value is that service's pull target.
export function workspaceImagesToPull(
  spec: ServiceHarnessSpec,
  imagePins: Record<string, string> | undefined,
  auth: RegistryAuth,
): string[] {
  const images = spec.services.map((s) => imagePins?.[s.name] ?? s.image);
  return [...new Set(images.filter((image) => imageUsesRegistryHost(image, auth.host)))];
}

// service harness: deploy and run the topology on the user's Docker daemon. No trustZones since it's a personal host; if the trace
// doesn't arrive, the topology degrades to snapshot (existing behavior). submit/getJson use the default fetch.
function defaultRunService(
  job: AgentJob,
  spec: ServiceHarnessSpec,
  runtimeOptions?: DockerTopologyRuntimeOptions,
): Promise<CaseResult> {
  const backend = new ServiceTopologyBackend({
    runtime: sharedTopologyRuntime(runtimeOptions), // reused across cases → keeps the warm-pool (topology deployed once per version)
    traceSource: buildTraceSource(spec.traceSource),
    specFor: () => spec,
  });
  return backend.dispatch(job);
}
