import { z } from "zod";
import { BadRequestError } from "../errors.js";
import { HarnessSpecSchema } from "../harness/harness-spec.js";
import { ModelBindingSchema } from "../harness/model-spec.js";
import { RegistryAuthSchema } from "../infra/image-ref.js";
import { EvalCaseSchema } from "./eval-case.js";

// per-run judge model config (not a secret). The control plane decides it from workspace/suite policy and loads it into the job.
// An inline judge grader (e.g. the WebVoyager preset) is judged with this model on the dispatch path. The provider 'key' is a secret (secretEnv).
// model is a Model BINDING (registered id/ref | raw string) — the SAME first-class binding a harness/registered judge uses.
// The dispatch seam (JudgeAuthDispatcher) resolves a registered Model to its provider/underlying model/baseUrl/apiKeySecret
// and rewrites this to the resolved underlying model string + provider before the env is built; a raw string passes through.
export const JudgeRunConfigSchema = z.object({
  provider: z.enum(["openai", "anthropic"]).optional(),
  model: ModelBindingSchema,
});
export type JudgeRunConfig = z.infer<typeof JudgeRunConfigSchema>;

// The judge model config ↔ env contract (the agent's judgeFromEnv reads it; the control plane/backend injects it into the alloc under these key names).
export const JUDGE_MODEL_ENV = "EVERDICT_JUDGE_MODEL";
export const JUDGE_PROVIDER_ENV = "EVERDICT_JUDGE_PROVIDER";

// JudgeRunConfig → env map. Empty map if unset (judge disabled). The key itself is injected separately by secretEnv
// (workspace tier, baked into the backend) or the job's transient judgeAuth (below).
export function judgeEnv(j?: JudgeRunConfig): Record<string, string> {
  if (!j) return {};
  // On the real dispatch path JudgeAuthDispatcher rewrites model to the resolved underlying string; extract it
  // defensively (a still-bound ref falls back to its id) so the env value is always a string.
  const model = typeof j.model === "string" ? j.model : j.model.ref;
  return { [JUDGE_MODEL_ENV]: model, ...(j.provider ? { [JUDGE_PROVIDER_ENV]: j.provider } : {}) };
}

// Transient judgeAuth → the judge provider's key/base-url env for the job. Spread AFTER secretEnv in the task env
// so a job-level resolved credential wins over the backend's baked workspace tier. Provider defaults to openai
// (matches judgeFromEnv on the agent side).
export function judgeAuthEnv(j?: JudgeRunConfig, auth?: { apiKey: string; baseUrl?: string }): Record<string, string> {
  if (!j || !auth) return {};
  const anthropic = j.provider === "anthropic";
  return {
    [anthropic ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"]: auth.apiKey,
    ...(auth.baseUrl ? { [anthropic ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL"]: auth.baseUrl } : {}),
  };
}

// A single unit of work passed from the control plane → job-runner.
// The agent takes only this and runs runCase to completion (harness under test + case).
// tenant: SaaS multi-tenant identifier — the key for fair scheduling/quota/isolation/billing. The agent ignores it.
// harnessSpec: the control plane resolves it from the registry and embeds it (a declarative command harness the agent interprets with no code).
//   If absent, the agent builds a built-in adapter (claude-code/scripted) from the id.
export const CaseJobSchema = z.object({
  evalCase: EvalCaseSchema,
  harness: z.object({ id: z.string(), version: z.string() }),
  harnessSpec: HarnessSpecSchema.optional(),
  // The model DOCUMENTS this batch pinned for that spec (arch-review 19 P0-4) — carried ON THE JOB because the
  // dispatcher is where a `{ref}` binding finally materializes into a provider, a base URL and a key, and it
  // has no other way to know what the batch certified. `pinHarnessSpecToClosure` already pins the VERSION
  // into the binding; a version is not an identity under owner-first resolution, so the digest travels with
  // it. Absent = nothing was pinned (a raw string binding, an unregistered model, a pre-pin batch), which the
  // dispatcher reads as "unverifiable", never as agreement.
  modelPins: z
    .object({
      model: z.string().optional(), // the command harness's own binding
      serviceModels: z.record(z.string(), z.string()).optional(), // per service name, for a topology harness
      // The RUNTIME judge configuration's model document (arch-review 20 P0-4). `judge.model` is the same
      // owner-first binding as any other, and it materializes at `JudgeAuthDispatcher` — a different seam
      // from the harness models above, and until now the only nested document with no digest behind it.
      judgeRun: z.string().optional(),
    })
    .optional(),
  tenant: z.string().optional(),
  // Submitter identifier (principal.subject) — for self-hosted runner dispatch. When placement.target is self:<runnerId>,
  // the RuntimeDispatcher checks the runner owner against this value and uses it in the lease queue key (tenant,submittedBy,runnerId).
  // The control plane fills it (unset if absent) and the agent ignores it (same as tenant — also matches the private repo clone owner).
  submittedBy: z.string().optional(),
  // Whether to meter usage — the control plane decides it from workspace/request policy and loads it into the job (replaces the global flag).
  // The agent prefers this value (falling back to the EVERDICT_METER_USAGE env in dev if unspecified). Only meaningful for command harnesses.
  meterUsage: z.boolean().optional(),
  // per-run judge model config — which model judges an inline judge grader present on the evalCase (not a secret).
  // The backend injects it via alloc env (EVERDICT_JUDGE_MODEL/PROVIDER); the provider key is secretEnv or judgeAuth. If unset, judge is skipped.
  judge: JudgeRunConfigSchema.optional(),
  // Transient judge provider credential — resolved at dispatch from the tenant's scoped secret tiers (workspace
  // first, the submitter's personal key as fallback) so a personal-only key still judges on MANAGED runtimes
  // (the backend-level secretEnv carries only the workspace tier). Same discipline as repoToken/registryAuth:
  // never persisted to records. Backends map it to the provider env (OPENAI_/ANTHROPIC_ API_KEY + BASE_URL); the
  // agent itself threads it into every compute exec (withJobEnv) so runner/local/docker paths see the same env.
  // Resolved on EVERY lane, self-hosted included (parity with harness {secretRef}/model-binding secrets); when no
  // key resolves on a self-hosted lane the job ships without it and the runner's machine env is the fallback (own-pays).
  judgeAuth: z.object({ apiKey: z.string(), baseUrl: z.string().optional() }).optional(),
  // Transient credential for private repo clone — the control plane resolves evalCase.env.source.connectionId to the token of the external
  // account connection (Connected accounts) and loads it here. RepoEnvironment uses it only for authenticated clone (http.extraheader) and
  // it is not persisted to the RunRecord/dataset (only the connectionId reference stays on the case).
  repoToken: z.string().optional(),
  // Image pull credentials (transient) — one entry per registry HOST this job's images live on: a managed-store grant
  // and/or the workspace's BYO registries (the control plane resolves pullSecretName). Same discipline as repoToken —
  // never persisted to results/datasets. Consumers (DockerDriver·runner topology pre-pull / nomad docker auth / k8s
  // imagePullSecrets) select the entries matching the images they are about to pull (pickRegistryAuth).
  // docs/architecture/managed-image-store.md
  registryAuths: z.array(RegistryAuthSchema).optional(),
  // (deprecated, dual-written) the singular predecessor of registryAuths. The control plane still fills it with the
  // first entry because a SELF-HOSTED RUNNER is user-installed and can lag the control plane — an older runner reads
  // only this field, and dropping it would silently un-authenticate its pulls. Consumers must read it only through
  // `registryAuthsOf` (which prefers the plural). Removable once runners have rolled past the plural field.
  registryAuth: RegistryAuthSchema.optional(),
  // per-dispatch image pins (service name → image) — override the service images of a registered service topology spec at run time
  // (extending register-time HarnessTemplate slot/pins to dispatch time). Only meaningful for service harnesses.
  // With pins present, a deterministic suffix is appended to the effective version so warm pools don't mix (a distinct topology identity).
  imagePins: z.record(z.string()).optional(),
  // Scheduling class — "interactive" (a person is waiting: single runs, probes) jumps ahead of "batch" (scorecard
  // fan-out) in the Scheduler's wait queue, so a 3-case check doesn't sit behind a 601-case batch. Tenant-fair WFQ
  // order is preserved WITHIN each class. Absent = batch-equivalent (only interactive jumps). The agent ignores it.
  priority: z.enum(["interactive", "batch"]).optional(),
  // Batch id (CP-internal) — lets the scheduler cancel a reclaimed batch's still-queued jobs precisely
  // (supersede / speculation-loser reclaim). The agent ignores it.
  batchId: z.string().optional(),
  // Trace-correlation run id, minted BY THE CONTROL PLANE at dispatch (evd-run-<runId> / evd-<batchId>-<caseId>[-t<n>])
  // so live observers can find the platform trace while the case is still running (docs/architecture/live-observability.md).
  // runCase uses it instead of self-minting; absent (tests/CLI) = the old in-job mint. Stable across spillover/
  // retries of the same record — a re-attempt's spans land under the same id (more evidence, same address).
  runId: z.string().optional(),
  // ── WHICH ATTEMPT'S RECORDING THIS JOB MAY WRITE INTO (review 39 P0-1) ─────────────────────────────
  //
  // The run id above is stable across spillover and retries ON PURPOSE — it is a correlation id, not the
  // identity of one physical execution. The recording fence, however, is per attempt, and the number was known
  // only to the process that opened it: a runner reported evidence with no generation at all, and the RECEIVING
  // process stamped whatever attempt its own local map happened to hold. A stale producer's frames were
  // therefore not merely accepted — they were re-labelled as its successor's.
  //
  // So the generation travels WITH THE JOB the producer leased. A producer that was never given one stamps 0,
  // which no opened attempt owns, and the store refuses it. Absent = a dispatch that opened no attempt (an
  // in-job collection with no recording store), which has nothing to write into either.
  recordingGeneration: z.number().int().nonnegative().optional(),
  // ── WHICH LEDGER ROW THIS JOB'S PHYSICAL EXECUTION IS (arch-review 51) ─────────────────────────────
  //
  // The generation above is the RECORDING fence, and it is absent exactly when the recording claim was
  // refused — while the attempt LEDGER row for that execution exists all the same. Everything downstream
  // therefore re-derived the row's name as `attemptIdOf(executionId, generation)` and got nothing for an
  // unisolated attempt: it opened, it ran, and no terminal stamp could address it. The name travels with the
  // job instead, so a lane that lost the generation has not lost the attempt.
  //
  // It is also what makes the SELF-HOSTED park able to say which attempt it is parking (runner_jobs
  // .current_attempt_id, mig 0183): the first re-lease reads that column as the predecessor it supersedes,
  // and with nothing written there the dispatch's own attempt stood `executing` for ever beside its successor.
  //
  // ⚠️ It names the attempt that opened THIS job. A path that restamps `recordingGeneration` with another
  // attempt's number (a re-lease's mint) must drop or replace this together with it — the two are one
  // coordinate, and disagreeing halves address two different executions.
  attemptId: z.string().optional(),
  // Trial index (0-based) when a case is dispatched N times for pass@k / flakiness. runSuite's fan-out stamps it so
  // the orchestration can key one child run per (case, trial) and the resulting CaseResult carries its trial. Absent =
  // single-run. The agent ignores it (it runs exactly one job); the control plane stamps the result. docs/architecture/trial-based-verdict.md
  trial: z.number().int().nonnegative().optional(),
});
export type CaseJob = z.infer<typeof CaseJobSchema>;

// ── WHAT THE AGENT MAY BE HANDED (arch-review 56, Wave B) ───────────────────────────────────────────
//
// A `CaseJob` is dispatched by base64-ing the WHOLE object into `EVERDICT_CASE_JOB` on the job container, and
// the harness under evaluation is spawned inside that container with the process environment inherited. So
// everything on this object is readable by the thing being measured.
//
// That is fine for the instruction, the environment and the harness spec — the agent needs them. It is not
// fine for `evalCase.graders[].config` when that config carries the DECISION PROCEDURE: a Terminal-Bench-format task puts
// its whole hidden `tests/` directory and the verifier's env (credentials included) in there, so an agent
// that reads its own environment reads the tests it is graded against. "Tests are copied after the agent
// finishes" is true of the FILESYSTEM and says nothing about disclosure — the bytes were handed over before
// the first token.
//
// Stripping is not available: the job-runner reconstructs the graders from this same object INSIDE the
// container, which is what lets an outcome grader touch `ctx.compute`. Agent and verifier share one
// environment by design, and until they do not, a case whose grading depends on material the agent must not
// see cannot be measured honestly on that lane.
//
// So it REFUSES. A silent disclosure that invalidates every score the benchmark produces becomes a visible
// error naming the case and the field, and the refusal is lifted by the isolated verifier lane rather than by
// remembering. `PRIVATE_GRADER_CONFIG_KEYS` is the closed list of fields that are constitutional rather than
// instructional; a new one is added HERE, once, instead of at each dispatcher.
export const PRIVATE_GRADER_CONFIG_KEYS = ["files", "env"] as const;

// Which graders on this case carry material the agent must not see. Empty = the case can be measured on a
// shared-environment lane. Named rather than boolean so the refusal can say WHICH grader and WHICH field,
// which is the difference between an error somebody acts on and one they work around.
export function verifierPrivateMaterial(evalCase: CaseJob["evalCase"]): string[] {
  const found: string[] = [];
  for (const grader of evalCase.graders ?? []) {
    const config = grader.config;
    if (config === undefined || config === null || typeof config !== "object") continue;
    for (const key of PRIVATE_GRADER_CONFIG_KEYS)
      if (Object.hasOwn(config as Record<string, unknown>, key)) found.push(`${grader.id}.${key}`);
  }
  return found;
}

// THE ONLY WAY A JOB BECOMES A DISPATCH PAYLOAD. A required call rather than a convention, for the reason the
// reservation proof is a required parameter: a backend that serialized the job itself would re-open this the
// moment somebody adds a lane, and nothing at the call site would look wrong.
export function caseJobPayload(job: CaseJob): string {
  const disclosed = verifierPrivateMaterial(job.evalCase);
  if (disclosed.length > 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { caseId: job.evalCase.id, disclosed },
      `case '${job.evalCase.id}' grades on material the agent must not see (${disclosed.join(", ")}), and this lane runs the agent and the verifier in one environment — the job payload is readable by the harness, so the case cannot be measured here. Run it on an isolated-verifier lane.`,
    );
  return Buffer.from(JSON.stringify(job)).toString("base64");
}
