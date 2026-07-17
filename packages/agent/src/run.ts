import { runCase } from "@everdict/application-execution";
import {
  type AgentJob,
  BadRequestError,
  type CaseResult,
  type Driver,
  type EnvSpec,
  type Environment,
  type Grader,
  type LiveScreenCapture,
  judgeAuthEnv,
  judgeEnv,
} from "@everdict/contracts";
import { classifyFailure, stageForError } from "@everdict/domain";
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
    default: {
      const exhaustive: never = kind;
      throw new BadRequestError("BAD_REQUEST", { envKind: exhaustive }, "unsupported env kind.");
    }
  }
}

// Wrap a driver so every exec of every handle it provisions sees the job-level env (merged under any per-exec env).
// This is the in-job equivalent of a managed alloc's task env: nomad/k8s inject judgeEnv/judgeAuthEnv at the alloc
// level and child processes inherit them, but on the runner/local/docker paths the agent process env has no such
// injection — without this, a code judge's script grader (compute.exec) never sees the judge model/credential.
// Job-level values win over the machine env (LocalDriver merges exec env over process.env); per-exec env wins over both.
export function withJobEnv(driver: Driver, env: Record<string, string>): Driver {
  return {
    id: driver.id,
    provision: async (spec) => {
      const handle = await driver.provision(spec);
      return {
        exec: (cmd, opts) => handle.exec(cmd, { ...opts, env: { ...env, ...opts?.env } }),
        writeFile: (path, data) => handle.writeFile(path, data),
        readFile: (path) => handle.readFile(path),
        dispose: () => handle.dispose(),
      };
    },
  };
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
    trace: [{ t: 0, kind: "error", message }],
    snapshot: { kind: "prompt", output: "" },
    scores: [
      { graderId: failure.stage, metric: "error", value: 0, pass: false, detail: `[${failure.class}] ${message}` },
    ],
    failure,
  };
}

// Runs one AgentJob end to end. Default driver=LocalDriver (in-process); DockerBackend injects a DockerDriver
// (runs the case in its own env-image container — e.g. SWE-bench prebuilt). If harnessSpec is present, interpret
// it as a declarative command harness. When containerize=true, run in a case.image container (DockerDriver) — used
// when a self-hosted runner runs an image-case on local Docker identically to the managed DockerBackend (an
// explicitly passed driver takes precedence). mounts are host resources to bind-mount into that container (e.g. the
// codex login directory → codex in the container uses the machine login). Design: docs/architecture/portable-harness-runtime.md.
export async function runAgentJob(
  job: AgentJob,
  opts: {
    driver?: Driver;
    containerize?: boolean;
    mounts?: DriverMount[];
    signal?: AbortSignal;
    // Live-screen frame reporter (self-hosted runner). When present AND the command harness declares liveScreen,
    // runCase execs the harness's captureCmd periodically and pushes each base64 PNG frame here. Absent = no live screen.
    reportScreen?: (frameBase64: string) => Promise<void>;
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
  // A remote alloc already has both injected into its task env by the backend; here the agent carries them itself so
  // the runner/local/docker paths behave the same — for the inline judge grader (below) AND for every compute exec
  // (withJobEnv), which is how a code judge's script sees EVERDICT_JUDGE_MODEL + the provider key on a self-hosted
  // runner. Absent judgeAuth (own-pays lanes), the machine env is the fallback.
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
  // registryAuth (transient on the job) — authenticated pre-pull of workspace-registry images (temporary DOCKER_CONFIG).
  const baseDriver =
    opts.driver ??
    (opts.containerize
      ? new DockerDriver({
          echo: true, // in-job: tee container output to the job log (live tail feed) — parity with LocalDriver
          ...(opts.mounts ? { mounts: opts.mounts } : {}),
          ...(job.registryAuth ? { registryAuth: job.registryAuth } : {}),
        })
      : new LocalDriver({ echo: true })); // in-job: tee harness output to the job log (live tail feed)
  return runCase(job.evalCase, {
    // Job-level judge env rides every exec (incl. an explicitly injected driver — DockerBackend) via the wrapper.
    driver: Object.keys(jobEnv).length > 0 ? withJobEnv(baseDriver, jobEnv) : baseDriver,
    environment,
    harness,
    graders,
    // Per-case timeout (EvalCase.timeoutSec) flows into the run context so a long agent case is not killed at the old
    // hardcoded default; EVERDICT_TIMEOUT_SEC still overrides. Dataset adapters (terminal-bench/harbor) capture the
    // task's own timeout here, previously dropped at execution.
    // signal (self-hosted lease cancel): threaded into the run context so runCase aborts mid-case and disposes the
    // compute (frees the runtime). Absent for managed dispatch (the backend kills the whole alloc instead).
    runCtx: {
      ...runContextFromEnv(job.evalCase.timeoutSec),
      ...(job.runId ? { runId: job.runId } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(liveScreen ? { liveScreen } : {}),
    },
  });
}
