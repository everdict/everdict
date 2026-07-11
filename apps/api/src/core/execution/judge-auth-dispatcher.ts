import type { DispatchOptions, Dispatcher } from "@everdict/backends";
import { type AgentJob, BadRequestError, type CaseResult } from "@everdict/contracts";

// The two secret tiers the control plane can resolve for a submitter (SecretStore.scopedEntries).
export interface ScopedSecretTiers {
  workspace: Record<string, string>;
  user: Record<string, string>;
}

export interface JudgeAuthDispatcherDeps {
  inner: Dispatcher;
  scopedSecretsFor: (tenant: string, subject?: string) => Promise<ScopedSecretTiers>;
}

// Resolves the inline judge's provider credential PER JOB at dispatch — the one seam every path shares
// (single runs, scorecard cases, retries, the Temporal bridge). Fixes two live gaps:
//  - tier asymmetry: the backend-level secretEnv carries only the WORKSPACE tier, so a submitter whose
//    provider key is a personal secret got a working harness but a silently skipped judge on managed runtimes.
//    Resolution order: workspace (the team's judge key) first, the submitter's personal key as fallback.
//  - silent skip: a judge model with NO resolvable key used to surface only as a "skipped" score after the
//    run. On managed targets that is now a fail-fast config error at dispatch (before any compute is spent).
// Self-hosted lanes (self / self:*) are exempt on both counts: the runner judges with its own machine env
// (own-pays) and the control plane cannot see that env — never ship workspace keys to user machines.
export class JudgeAuthDispatcher implements Dispatcher {
  constructor(private readonly deps: JudgeAuthDispatcherDeps) {}

  async dispatch(job: AgentJob, opts?: DispatchOptions): Promise<CaseResult> {
    const target = job.evalCase.placement?.target;
    const selfHosted = target === "self" || target?.startsWith("self:") === true;
    if (!job.judge || job.judgeAuth !== undefined || selfHosted) return this.deps.inner.dispatch(job, opts);
    const tenant = job.tenant ?? "default";
    // A secret-store failure propagates as-is (infra) — only a MISSING key is a config error.
    const scoped = await this.deps.scopedSecretsFor(tenant, job.submittedBy);
    const anthropic = job.judge.provider === "anthropic";
    const keyName = anthropic ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    const baseName = anthropic ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL";
    const apiKey = scoped.workspace[keyName] ?? scoped.user[keyName];
    const baseUrl = scoped.workspace[baseName] ?? scoped.user[baseName];
    if (apiKey === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { judgeModel: job.judge.model, secret: keyName },
        `judge model '${job.judge.model}' is configured but no ${keyName} secret is resolvable (workspace or personal) — set the secret or submit without a judge.`,
      );
    return this.deps.inner.dispatch({ ...job, judgeAuth: { apiKey, ...(baseUrl ? { baseUrl } : {}) } }, opts);
  }
}
