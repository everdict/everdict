import type {
  CaseFsServicing,
  CaseJob,
  CaseResult,
  RegistryAuth,
  ServiceHarnessSpec,
  TraceEvent,
} from "@everdict/contracts";
import { pickRegistryAuth, registryAuthsOf } from "@everdict/domain";
import { type DriverMount, pullWithRegistryAuth, runCaseJob } from "@everdict/job-runner";
import {
  DockerTopologyRuntime,
  type DockerTopologyRuntimeOptions,
  type EnvRecordSink,
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

// Branch a leased job by harness kind. service (topology) → local Docker topology, otherwise → runCaseJob.
// If a non-service case declares case.image and this runner has Docker, run in that image's container (DockerDriver) —
// the same path as the managed DockerBackend, so "one definition, same environment whether managed or local" holds. Otherwise host-native LocalDriver.
// Design: docs/architecture/portable-harness-runtime.md · self-hosted-service-runner.md. The branch lives in exactly one place.
export async function runLeasedJob(
  job: CaseJob,
  opts: {
    runService?: (job: CaseJob) => Promise<CaseResult>; // test injection
    runProcess?: (
      job: CaseJob,
      runOpts: {
        containerize?: boolean;
        mounts?: DriverMount[];
        signal?: AbortSignal;
        reportScreen?: (frameBase64: string) => Promise<void>;
        reportTrace?: (events: TraceEvent[]) => Promise<void>;
        caseFs?: CaseFsServicing;
      },
    ) => Promise<CaseResult>;
    runtimeOptions?: DockerTopologyRuntimeOptions; // service topology runtime tuning (readiness timeout etc.)
    dockerAvailable?: boolean; // whether this runner has a Docker daemon (capability) — the gate for running image-cases in a container
    mounts?: DriverMount[]; // host resources to bind into the container when containerizing (e.g. codex login) — runner opt-in
    log?: (msg: string) => void; // notify the reason (e.g. image required but no Docker) — no silent failure
    pullImage?: (image: string, auth: RegistryAuth) => Promise<void>; // test injection (default pullWithRegistryAuth)
    // Cooperative cancellation (lease cancel): when it aborts, the case run stops and its compute/topology is torn
    // down — the runtime is freed mid-case. The runner mints it locally on a heartbeat 'cancelled' signal.
    signal?: AbortSignal;
    // Live-screen frame reporter — the runner pushes each captured frame to the control plane. Only meaningful for a
    // containerized command harness that declares liveScreen (host-native execution has no isolated screen to capture).
    reportScreen?: (frameBase64: string) => Promise<void>;
    // Environment-plane record sink (replay ②) — a service (topology) case's CDP recorder streams the per-case browser's
    // network/console/nav (+ frames) through here to the durable recorder. Only used by the topology branch below.
    recordSink?: EnvRecordSink;
    // Live-trace batch reporter (observability ⑨) — passed through to runCaseJob unconditionally (the trace is
    // universal, unlike the screen): host-native and containerized runs both tee their drained TraceEvents out.
    reportTrace?: (events: TraceEvent[]) => Promise<void>;
    // Run-workbench fs servicing (self-hosted parity) — passed through to runCaseJob unconditionally: host-native
    // and containerized repo cases both answer the control plane's parked reads from inside the case.
    caseFs?: CaseFsServicing;
  } = {},
): Promise<CaseResult> {
  const spec = job.harnessSpec;
  if (spec?.kind === "service") {
    // Authenticated pre-pull (temporary DOCKER_CONFIG) of credentialed service images before deploy — the topology runtime's
    // docker run uses the local image (the runtime interface is unchanged). Failures propagate as-is (if the pull fails, deploy can't happen either).
    for (const { image, auth } of workspaceImagesToPull(spec, job.imagePins, registryAuthsOf(job))) {
      opts.log?.(`pulling credentialed image: ${image}`);
      await (opts.pullImage ?? pullWithRegistryAuth)(image, auth);
    }
    const runService =
      opts.runService ??
      ((j: CaseJob) => defaultRunService(j, spec, opts.runtimeOptions, opts.signal, opts.recordSink));
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
  // Live-screen capture is passed only for containerized runs — the capture command targets the case container.
  return (opts.runProcess ?? runCaseJob)(job, {
    containerize,
    ...(containerize && opts.mounts?.length ? { mounts: opts.mounts } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(containerize && opts.reportScreen ? { reportScreen: opts.reportScreen } : {}),
    ...(opts.reportTrace ? { reportTrace: opts.reportTrace } : {}),
    ...(opts.caseFs ? { caseFs: opts.caseFs } : {}),
  });
}

// The authenticated pre-pull targets (pure) — among the service images (with per-dispatch image-pin overrides applied),
// each image paired with the credential covering its registry host, deduped. Images no credential covers are dropped
// (public/base images pull anonymously). A pin swaps a service's image, so the pin value is that service's pull target.
// Pairing per image (rather than filtering by one host) is what lets one topology pull from several registries.
export function workspaceImagesToPull(
  spec: ServiceHarnessSpec,
  imagePins: Record<string, string> | undefined,
  auths: RegistryAuth[],
): { image: string; auth: RegistryAuth }[] {
  // Host-exec services carry no image (nothing to pull).
  const images = spec.services.flatMap((s) => {
    const image = imagePins?.[s.name] ?? s.image;
    return image ? [image] : [];
  });
  return [...new Set(images)].flatMap((image) => {
    const auth = pickRegistryAuth(auths, image);
    return auth ? [{ image, auth }] : [];
  });
}

// service harness: deploy and run the topology on the user's Docker daemon. No trustZones since it's a personal host; if the trace
// doesn't arrive, the topology degrades to snapshot (existing behavior). submit/getJson use the default fetch.
function defaultRunService(
  job: CaseJob,
  spec: ServiceHarnessSpec,
  runtimeOptions?: DockerTopologyRuntimeOptions,
  signal?: AbortSignal,
  recordSink?: EnvRecordSink,
): Promise<CaseResult> {
  const backend = new ServiceTopologyBackend({
    runtime: sharedTopologyRuntime(runtimeOptions), // reused across cases → keeps the warm-pool (topology deployed once per version)
    traceSource: buildTraceSource(spec.traceSource),
    specFor: () => spec,
    // Replay ② — stream the per-case browser's CDP events into the durable recording (self-hosted path: report_case_* MCP).
    ...(recordSink ? { recordSink: () => recordSink } : {}),
  });
  // Thread cancellation into the topology dispatch — it refuses a pre-aborted run and stops waiting on abort.
  return backend.dispatch(job, signal ? { signal } : undefined);
}
