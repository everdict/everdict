import type { DispatchOptions, Dispatcher } from "@everdict/backends";
import { type AgentJob, BadRequestError, type CaseResult, type ModelSpec } from "@everdict/contracts";
import { modelApiKeySecretName, normalizeModelBinding } from "@everdict/domain";
import type { ModelRegistry } from "@everdict/registry";

// The two secret tiers the control plane can resolve for a submitter (SecretStore.scopedEntries).
export interface ScopedSecretTiers {
  workspace: Record<string, string>;
  user: Record<string, string>;
}

export interface JudgeAuthDispatcherDeps {
  inner: Dispatcher;
  scopedSecretsFor: (tenant: string, subject?: string) => Promise<ScopedSecretTiers>;
  // Resolve a judge's Model binding (ref → provider / underlying model / baseUrl / apiKeySecret), the same registry the
  // harness ModelResolvingDispatcher + the in-process JudgeRunner use. Absent → raw-string models only (an explicit ref
  // then fails fast, since it can't be resolved).
  models?: ModelRegistry;
}

// Resolves the inline judge's Model binding + provider credential PER JOB at dispatch — the one seam every path shares
// (single runs, scorecard cases, retries, the Temporal bridge). The judge's `model` is a first-class Model binding
// (ref | raw string): a registered Model contributes provider / underlying model / baseUrl / apiKeySecret, resolved the
// same way as a harness model, then job.judge is rewritten to the resolved form. On top of that it fixes two live gaps:
//  - tier asymmetry: the backend-level secretEnv carries only the WORKSPACE tier, so a submitter whose
//    provider key is a personal secret got a working harness but a silently skipped judge on managed runtimes.
//    Resolution order: workspace (the team's judge key) first, the submitter's personal key as fallback.
//  - silent skip: a judge model with NO resolvable key used to surface only as a "skipped" score after the
//    run. On managed targets that is now a fail-fast config error at dispatch (before any compute is spent).
// Self-hosted lanes (self / self:*) get the SAME resolved credential as managed ones — the harness path already
// ships workspace secrets to the runner ({secretRef} env + model-binding keys, resolveHarnessSecrets /
// ModelResolvingDispatcher), so withholding only the judge key was an inconsistency that broke co-located code
// judges (401 on the runner). The one self-hosted difference: a MISSING key is not fail-fast — the job ships
// without judgeAuth and the runner's own machine env is the fallback (own-pays stays possible).
export class JudgeAuthDispatcher implements Dispatcher {
  constructor(private readonly deps: JudgeAuthDispatcherDeps) {}

  async dispatch(job: AgentJob, opts?: DispatchOptions): Promise<CaseResult> {
    if (!job.judge) return this.deps.inner.dispatch(job, opts);
    const tenant = job.tenant ?? "default";

    // 1) Resolve the judge's Model BINDING → provider / underlying model / baseUrl / apiKeySecret, the same first-class
    //    way a harness (ModelResolvingDispatcher) and the in-process JudgeRunner do. This (non-secret) resolution runs
    //    for ALL lanes so the agent always judges with the real underlying model; the job.judge is rewritten to the
    //    resolved form so judgeEnv emits it. A bare string that isn't a registered id stays a raw model name; an
    //    EXPLICIT ref that can't resolve is a fail-fast config error (never dispatched with an unresolved model).
    const binding = job.judge.model;
    const { ref, version } = normalizeModelBinding(binding);
    const explicitRef = typeof binding !== "string";
    let provider: "anthropic" | "openai" = job.judge.provider ?? "openai";
    let model = ref;
    let modelBaseUrl: string | undefined;
    let keyName = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    let resolved: ModelSpec | undefined;
    if (this.deps.models) {
      try {
        resolved = await this.deps.models.get(tenant, ref, version);
      } catch {
        resolved = undefined; // not a registered id
      }
    }
    if (resolved) {
      provider = resolved.provider;
      model = resolved.model;
      modelBaseUrl = resolved.baseUrl;
      keyName = modelApiKeySecretName(resolved);
    } else if (explicitRef) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { model: ref },
        `judge references model '${ref}${version === "latest" ? "" : `@${version}`}' but no such model is registered in this workspace.`,
      );
    }
    // Rewrite job.judge to the resolved underlying model + provider (judgeEnv reads it downstream).
    const resolvedJudge = { provider, model };

    // 2) Key injection — every lane, self-hosted included (parity with the harness secret path). A job that already
    //    carries judgeAuth (a retry) keeps it; all paths get the resolved model on job.judge.
    if (job.judgeAuth !== undefined) {
      return this.deps.inner.dispatch({ ...job, judge: resolvedJudge }, opts);
    }
    const baseName = provider === "anthropic" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL";
    // A secret-store failure propagates as-is (infra) — only a MISSING key is a config error.
    const scoped = await this.deps.scopedSecretsFor(tenant, job.submittedBy);
    const apiKey = scoped.workspace[keyName] ?? scoped.user[keyName]; // workspace (the team's key) first, personal fallback
    const baseUrl = modelBaseUrl ?? scoped.workspace[baseName] ?? scoped.user[baseName]; // the model's baseUrl wins
    if (apiKey === undefined) {
      // Self-hosted lanes soften the fail-fast: no resolvable key means the runner judges with its own machine
      // env (own-pays) — ship the job without judgeAuth instead of refusing to dispatch.
      const target = job.evalCase.placement?.target;
      const selfHosted = target === "self" || target?.startsWith("self:") === true;
      if (selfHosted) return this.deps.inner.dispatch({ ...job, judge: resolvedJudge }, opts);
      throw new BadRequestError(
        "BAD_REQUEST",
        { judgeModel: model, secret: keyName },
        `judge model '${model}' is configured but no ${keyName} secret is resolvable (workspace or personal) — set the secret or submit without a judge.`,
      );
    }
    return this.deps.inner.dispatch(
      { ...job, judge: resolvedJudge, judgeAuth: { apiKey, ...(baseUrl ? { baseUrl } : {}) } },
      opts,
    );
  }
}
