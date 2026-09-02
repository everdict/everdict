import { runCase } from "@everdict/application-execution";
import {
  BadRequestError,
  CURRENT_EVIDENCE_VERSION,
  type CaseFsServicing,
  type CaseJob,
  type CaseResult,
  type Driver,
  type EnvSpec,
  type Environment,
  type Grader,
  type LiveScreenCapture,
  type TraceEvent,
  judgeAuthEnv,
  judgeEnv,
} from "@everdict/contracts";
import { classifyFailure, registryAuthsOf, stageForError } from "@everdict/domain";
import { DockerDriver, type DriverMount, LocalDriver } from "@everdict/drivers";
import { OsUseEnvironment, PromptEnvironment, RepoEnvironment } from "@everdict/environments";
import { runContextFromEnv } from "./env.js";
import { makeGradersFromEnv, makeHarness } from "./registry.js";

// Whether to meter the harness's model usage for this dispatch. The usage-proxy binds 127.0.0.1 on the runner host,
// unreachable from inside a container — so metering MUST be off whenever the case runs containerized. That is true
// two ways: the containerize flag (self-hosted runner image-cases) OR an explicitly injected container driver
// (DockerBackend runs the case in an env-image container WITHOUT setting the flag). Keying only off the flag left
// the DockerBackend path metered, rewriting the child's model base URL to a dead loopback endpoint and killing every
// model call — the exact failure this guard exists to prevent. See docs/usage-metering.md.
export function resolveMeterUsage(requested: boolean, opts: { containerize?: boolean; driver?: Driver }): boolean {
  const containerized = opts.containerize === true || opts.driver instanceof DockerDriver;
  return requested && !containerized;
}

// env.kind → Environment. Exhaustive: prompt (QA), os-use (desktop), repo (coding/seed — authenticated clone with
// repoToken for a private seed). browser is a service-topology target env provisioned by ServiceTopologyBackend and
// must never reach this local agent path — fail loud (config, non-retryable) rather than silently mishandling it as
// a repo. The `never` guard turns a newly added env.kind into a compile error here instead of a silent fall-through.
function environmentFor(kind: EnvSpec["kind"], repoToken?: string): Environment {
  switch (kind) {
    case "prompt":
      return new PromptEnvironment();
    case "os-use":
      return new OsUseEnvironment();
    case "repo":
      return new RepoEnvironment(repoToken !== undefined ? { gitToken: repoToken } : {});
    case "browser":
      throw new BadRequestError(
        "BAD_REQUEST",
        { envKind: kind },
        "browser env is not runnable on the local agent path (use a service topology backend).",
      );
    // A REFERENCE reaches a sandbox only if the control plane failed to resolve it (harness-definability-spec
    // §2). `resolveCaseEnvironments` runs at submit and on every execution lane, so this is a wiring failure,
    // never a case shape — and guessing a seed for it would run the case against a world nobody named.
    case "ref":
      throw new BadRequestError(
        "BAD_REQUEST",
        { envKind: kind },
        "this case names its environment by reference and the reference was never resolved — the control plane resolves it before dispatch.",
      );
    default: {
      const exhaustive: never = kind;
      throw new BadRequestError("BAD_REQUEST", { envKind: exhaustive }, "unsupported env kind.");
    }
  }
}

// The classified CaseResult the agent emits when a job fails to produce a normal eval outcome. Crossing the process
// boundary as a CLASSIFIED result (not a bare crash) preserves WHERE the case died (dispatch|install|run|grade) — a
// bare non-zero exit surfaces backend-side as a mushy "sentinel not found" dispatch error. When the job is not yet
// available (base64/JSON/schema parse failed before it was decoded) the stage is dispatch and the identity unknown;
// otherwise the stage comes from the error code.
export function failureResult(
  err: unknown,
  job?: { evalCase: { id: string }; harness: { id: string; version: string } },
): CaseResult {
  const stage = job ? stageForError(err) : "dispatch";
  const failure = classifyFailure(err, stage);
  const message = err instanceof Error ? err.message : String(err);
  return {
    caseId: job?.evalCase.id ?? "unknown",
    harness: job ? `${job.harness.id}@${job.harness.version}` : "unknown@unknown",
    evidenceVersion: CURRENT_EVIDENCE_VERSION, // nothing was collected, and the era is what says so
    trace: [{ t: 0, kind: "error", message }],
    snapshot: { kind: "prompt", output: "" },
    // UNMEASURED diagnostic, not a measurement (run-suite failedCaseResult twin): with no status this score
    // was "measured" — a mean-0/pass:false row — and a collect/grade-stage failure (outside PRE_OUTCOME_STAGES)
    // even DECIDED the case on the fallback rung: an infra failure read as a product FAIL.
    scores: [
      {
        graderId: failure.stage,
        metric: "error",
        status: "unmeasured",
        reason: "missing_evidence",
        retryable: failure.retryable,
        detail: `[${failure.class}] ${message}`,
      },
    ],
    failure,
  };
}

// Runs one CaseJob end to end. Default driver=LocalDriver (in-process); DockerBackend injects a DockerDriver
// (runs the case in its own env-image container — e.g. SWE-bench prebuilt). If harnessSpec is present, interpret
// it as a declarative command harness. When containerize=true, run in a case.image container (DockerDriver) — used
// when a self-hosted runner runs an image-case on local Docker identically to the managed DockerBackend (an
// explicitly passed driver takes precedence). mounts are host resources to bind-mount into that container (e.g. the
// codex login directory → codex in the container uses the machine login). Design: docs/architecture/portable-harness-runtime.md.
export async function runCaseJob(
  job: CaseJob,
  opts: {
    driver?: Driver;
    containerize?: boolean;
    mounts?: DriverMount[];
    signal?: AbortSignal;
    // Live-screen frame reporter (self-hosted runner). When present AND the command harness declares liveScreen,
    // runCase execs the harness's captureCmd periodically and pushes each base64 PNG frame here. Absent = no live screen.
    reportScreen?: (frameBase64: string) => Promise<void>;
    // Live-trace batch reporter (live-observability ⑨). When present, runCase tees every drained TraceEvent here in
    // short-cadence batches — the self-hosted runner pushes them to the control plane, the managed entry prints
    // EVENT_SENTINEL stdout lines. Unconditional (no spec opt-in): the trace is universal across harnesses.
    reportTrace?: (events: TraceEvent[]) => Promise<void>;
    // Run-workbench fs servicing (self-hosted runner): poll the control plane's parked repo reads and answer them
    // from inside the case — the workbench's self-hosted parity (the CP cannot exec into a runner's sandbox).
    caseFs?: CaseFsServicing;
  } = {},
): Promise<CaseResult> {
  // Usage metering (BYO + Everdict-owned budget): the control plane decides from workspace/request policy and sends it via job.meterUsage.
  // If unset, fall back for dev to the EVERDICT_METER_USAGE env (when dispatching directly to LocalBackend without a control plane).
  // When on, the command harness routes model calls through a usage-proxy to recover tokens → carried into the result as synthetic trace events.
  // Containerized jobs are excluded fail-safe (see resolveMeterUsage).
  const requestedMetering = job.meterUsage ?? process.env.EVERDICT_METER_USAGE === "1";
  const meterUsage = resolveMeterUsage(requestedMetering, opts);
  if (requestedMetering && !meterUsage)
    console.error(
      "⚠ meterUsage requested but the case runs in a container — the loopback usage-proxy is unreachable from a container, so metering is disabled for this case (use trace instrumentation instead).",
    );
  const harness = makeHarness(job.harness.id, job.harness.version, job.harnessSpec, { meterUsage });
  // Job-level judge env: model config (job.judge) + the dispatch-resolved provider credential (job.judgeAuth).
  // A remote alloc already has both injected into its task env by the backend; here the runner carries them itself
  // so the runner/local/docker paths behave the same — for the inline judge grader (below) AND for a code judge's
  // script, which reads EVERDICT_JUDGE_MODEL and the provider key from the env of the exec that runs it. Absent
  // judgeAuth (own-pays lanes), the machine env is the fallback.
  //
  // It goes to `runCase` as `graderEnv` — the GRADING half only. It used to wrap the driver, which put the
  // tenant's provider key on every exec through the compute both halves share, including the agent's
  // (arch-review 58 W1).
  const jobEnv = { ...judgeEnv(job.judge), ...judgeAuthEnv(job.judge, job.judgeAuth) };
  // Include the judge grader: build the Judge from env + job-level judge env.
  // If unconfigured, only the judge spec gets a skip score (so a normal eval doesn't die).
  const env = { ...process.env, ...jobEnv };
  const graders: Grader[] = makeGradersFromEnv(job.evalCase.graders, env);
  // Environment is chosen by the case's env.kind (browser topology is handled by ServiceTopologyBackend — outside this local path).
  const environment = environmentFor(job.evalCase.env.kind, job.repoToken);
  // Opt-in live screen: a command harness that drives a browser/GUI in its own container declares a captureCmd; when the
  // caller (self-hosted runner) also supplies a frame reporter, runCase runs the capture loop against the case compute.
  const liveScreenSpec = job.harnessSpec?.kind === "command" ? job.harnessSpec.liveScreen : undefined;
  const liveScreen: LiveScreenCapture | undefined =
    liveScreenSpec && opts.reportScreen
      ? {
          captureCmd: liveScreenSpec.captureCmd,
          report: opts.reportScreen,
          ...(liveScreenSpec.intervalMs !== undefined ? { intervalMs: liveScreenSpec.intervalMs } : {}),
        }
      : undefined;
  // Precedence: explicit driver → containerize (local Docker, case.image, host mounts) → default LocalDriver (in-process).
  // registryAuths (transient on the job) — authenticated pre-pull of credentialed images (temporary DOCKER_CONFIG).
  const registryAuths = registryAuthsOf(job);
  const baseDriver =
    opts.driver ??
    (opts.containerize
      ? new DockerDriver({
          echo: true, // in-job: tee container output to the job log (live tail feed) — parity with LocalDriver
          ...(opts.mounts ? { mounts: opts.mounts } : {}),
          ...(registryAuths.length > 0 ? { registryAuths } : {}),
        })
      : new LocalDriver({
          echo: true, // in-job: tee harness output to the job log (live tail feed)
          // What the backend that built THIS container says it enforced (arch-review 57 P1-high). A host
          // process can enforce no cpu ceiling, so a declared world is refused here — unless the layer that
          // made the box states it applied that exact declaration, which the driver then checks. Absent on a
          // bare host run, so `everdict run` still refuses a world it cannot provide.
          ...(job.worldProof ? { worldProof: job.worldProof } : {}),
        }));
  return runCase(job.evalCase, {
    driver: baseDriver,
    environment,
    harness,
    graders,
    // ── THE JUDGE'S KEY GOES TO THE GRADERS, NOT TO THE AGENT (arch-review 58, W1) ──────────────
    //
    // This used to wrap the DRIVER (`withJobEnv`), which put the judge's model config and the provider key
    // resolved for this dispatch on every exec through the one compute both halves share. The consumer was
    // always the grading half — a code judge's script reading EVERDICT_JUDGE_MODEL and the key — and the
    // other process sharing that environment is the agent under test: arbitrary code, permissions
    // deliberately disabled, holding the tenant's provider credential for the length of the run.
    //
    // `runCase` hands it to the graders' view of the compute instead. Same consumer, same value; the harness's
    // environment no longer contains a credential it never needed.
    ...(Object.keys(jobEnv).length > 0 ? { graderEnv: jobEnv } : {}),
    // The harness version's seeds, materialized by the control plane (harness-identity-and-seeds-spec.md §2).
    ...(job.seedFiles !== undefined ? { seedFiles: job.seedFiles } : {}),
    // The lane's attestation, onto the manifest `runCase` writes — the same value the driver above checks the
    // declaration against, so what gets recorded is what was verified (arch-review 59 P1-high).
    ...(job.worldProof ? { worldProof: job.worldProof } : {}),
    // Per-case timeout (EvalCase.timeoutSec) flows into the run context so a long agent case is not killed at the old
    // hardcoded default; EVERDICT_TIMEOUT_SEC still overrides. Container-task dataset adapters capture the
    // task's own timeout here, previously dropped at execution.
    // signal (self-hosted lease cancel): threaded into the run context so runCase aborts mid-case and disposes the
    // compute (frees the runtime). Absent for managed dispatch (the backend kills the whole alloc instead).
    runCtx: {
      ...runContextFromEnv(job.evalCase.timeoutSec),
      // The case's id and environment declaration, for a command's `{{case.*}}` tokens (definability spec §4).
      evalCase: { id: job.evalCase.id, env: job.evalCase.env },
      ...(job.runId ? { runId: job.runId } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(liveScreen ? { liveScreen } : {}),
      ...(opts.reportTrace ? { liveTrace: { report: opts.reportTrace } } : {}),
      ...(opts.caseFs ? { caseFs: opts.caseFs } : {}),
    },
  });
}
