import { type AgentJob, type CaseResult, type Driver, type Environment, type Grader, judgeEnv } from "@everdict/core";
import { DockerDriver, type DriverMount, LocalDriver } from "@everdict/drivers";
import { OsUseEnvironment, PromptEnvironment, RepoEnvironment } from "@everdict/environments";
import { runCase } from "@everdict/runner";
import { runContextFromEnv } from "./env.js";
import { makeGradersFromEnv, makeHarness } from "./registry.js";

// Delimiter the agent uses to emit the result to stdout. The backend parses this line from logs.
export const RESULT_SENTINEL = "__EVERDICT_RESULT__";

// Runs one AgentJob end to end. Default driver=LocalDriver (in-process); DockerBackend injects a DockerDriver
// (runs the case in its own env-image container — e.g. SWE-bench prebuilt). If harnessSpec is present, interpret
// it as a declarative command harness. When containerize=true, run in a case.image container (DockerDriver) — used
// when a self-hosted runner runs an image-case on local Docker identically to the managed DockerBackend (an
// explicitly passed driver takes precedence). mounts are host resources to bind-mount into that container (e.g. the
// codex login directory → codex in the container uses the machine login). Design: docs/architecture/portable-harness-runtime.md.
export async function runAgentJob(
  job: AgentJob,
  opts: { driver?: Driver; containerize?: boolean; mounts?: DriverMount[] } = {},
): Promise<CaseResult> {
  // Usage metering (BYO + Everdict-owned budget): the control plane decides from workspace/request policy and sends it via job.meterUsage.
  // If unset, fall back for dev to the EVERDICT_METER_USAGE env (when dispatching directly to LocalBackend without a control plane).
  // When on, the command harness routes model calls through a usage-proxy to recover tokens → carried into the result as synthetic trace events.
  const meterUsage = job.meterUsage ?? process.env.EVERDICT_METER_USAGE === "1";
  const harness = makeHarness(job.harness.id, job.harness.version, job.harnessSpec, { meterUsage });
  // Include the judge grader: build the Judge from env (key=secretEnv) + job.judge (model/provider, loaded onto the job by the control plane).
  // A remote alloc already has judgeEnv injected into env by the backend, but merge here so local (process.env) behaves the same.
  // If unconfigured, only the judge spec gets a skip score (so a normal eval doesn't die).
  const env = { ...process.env, ...judgeEnv(job.judge) };
  const graders: Grader[] = makeGradersFromEnv(job.evalCase.graders, env);
  // Environment is chosen by the case's env.kind: prompt (QA) → Prompt, os-use (desktop) → OsUse, otherwise → Repo (coding/seed).
  // (browser topology is handled by ServiceTopologyBackend — outside this local path.)
  const k = job.evalCase.env.kind;
  // repo: for a private seed, authenticated clone (http.extraheader) using job.repoToken, which the control plane resolved from the external account connection.
  const environment: Environment =
    k === "prompt"
      ? new PromptEnvironment()
      : k === "os-use"
        ? new OsUseEnvironment()
        : new RepoEnvironment(job.repoToken !== undefined ? { gitToken: job.repoToken } : {});
  return runCase(job.evalCase, {
    // Precedence: explicit driver → containerize (local Docker, case.image, host mounts) → default LocalDriver (in-process).
    // registryAuth (transient on the job) — authenticated pre-pull of workspace-registry images (temporary DOCKER_CONFIG).
    driver:
      opts.driver ??
      (opts.containerize
        ? new DockerDriver({
            ...(opts.mounts ? { mounts: opts.mounts } : {}),
            ...(job.registryAuth ? { registryAuth: job.registryAuth } : {}),
          })
        : new LocalDriver()),
    environment,
    harness,
    graders,
    runCtx: runContextFromEnv(),
  });
}
