import { z } from "zod";
import { HarnessSpecSchema } from "../harness/harness-spec.js";
import { RegistryAuthSchema } from "../infra/image-ref.js";
import { EvalCaseSchema } from "./eval-case.js";

// per-run judge model config (not a secret). The control plane decides it from workspace/suite policy and loads it into the job.
// An inline judge grader (e.g. the WebVoyager preset) is judged with this model on the dispatch path. The provider 'key' is a secret (secretEnv).
export const JudgeRunConfigSchema = z.object({
  provider: z.enum(["openai", "anthropic"]).optional(),
  model: z.string(),
});
export type JudgeRunConfig = z.infer<typeof JudgeRunConfigSchema>;

// The judge model config ↔ env contract (the agent's judgeFromEnv reads it; the control plane/backend injects it into the alloc under these key names).
export const JUDGE_MODEL_ENV = "EVERDICT_JUDGE_MODEL";
export const JUDGE_PROVIDER_ENV = "EVERDICT_JUDGE_PROVIDER";

// JudgeRunConfig → env map. Empty map if unset (judge disabled). The key itself is injected separately by secretEnv
// (workspace tier, baked into the backend) or the job's transient judgeAuth (below).
export function judgeEnv(j?: JudgeRunConfig): Record<string, string> {
  if (!j) return {};
  return { [JUDGE_MODEL_ENV]: j.model, ...(j.provider ? { [JUDGE_PROVIDER_ENV]: j.provider } : {}) };
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

// A single unit of work passed from the control plane → runner agent.
// The agent takes only this and runs runCase to completion (harness under test + case).
// tenant: SaaS multi-tenant identifier — the key for fair scheduling/quota/isolation/billing. The agent ignores it.
// harnessSpec: the control plane resolves it from the registry and embeds it (a declarative command harness the agent interprets with no code).
//   If absent, the agent builds a built-in adapter (claude-code/scripted) from the id.
export const AgentJobSchema = z.object({
  evalCase: EvalCaseSchema,
  harness: z.object({ id: z.string(), version: z.string() }),
  harnessSpec: HarnessSpecSchema.optional(),
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
  // never persisted to records. Backends map it to the provider env (OPENAI_/ANTHROPIC_ API_KEY + BASE_URL);
  // self-hosted runner dispatch never carries it (the runner judges with its own env — own-pays).
  judgeAuth: z.object({ apiKey: z.string(), baseUrl: z.string().optional() }).optional(),
  // Transient credential for private repo clone — the control plane resolves evalCase.env.source.connectionId to the token of the external
  // account connection (Connected accounts) and loads it here. RepoEnvironment uses it only for authenticated clone (http.extraheader) and
  // it is not persisted to the RunRecord/dataset (only the connectionId reference stays on the case).
  repoToken: z.string().optional(),
  // Workspace image registry pull credential (transient) — when a job image belongs to a workspace registry host,
  // the control plane resolves pullSecretName and loads it here (same discipline as repoToken — never persisted to results/datasets).
  // Consumers: DockerDriver·runner topology pre-pull / nomad docker auth / k8s imagePullSecrets. docs/architecture/workspace-image-registry.md
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
  // Trial index (0-based) when a case is dispatched N times for pass@k / flakiness. runSuite's fan-out stamps it so
  // the orchestration can key one child run per (case, trial) and the resulting CaseResult carries its trial. Absent =
  // single-run. The agent ignores it (it runs exactly one job); the control plane stamps the result. docs/architecture/trial-based-verdict.md
  trial: z.number().int().nonnegative().optional(),
});
export type AgentJob = z.infer<typeof AgentJobSchema>;
