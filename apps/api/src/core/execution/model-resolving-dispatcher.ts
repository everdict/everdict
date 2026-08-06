import type { DispatchOptions, Dispatcher } from "@everdict/backends";
import {
  BadRequestError,
  type CaseJob,
  type CaseResult,
  type HarnessSpec,
  type ModelBinding,
  type ModelSpec,
} from "@everdict/contracts";
import { modelApiKeySecretName, modelConnectionEnv, normalizeModelBinding } from "@everdict/domain";
import type { ModelRegistry } from "@everdict/registry";
import type { ScopedSecretTiers } from "./judge-auth-dispatcher.js";

// Resolve a harness's Model reference(s) at a single point right before dispatch — the twin of JudgeAuthDispatcher for
// the harness under test. Three things happen from one registered-Model lookup:
//   1. provenance — a command harness's {{model}} slot (its `model` string/ref) becomes the underlying model identifier,
//      so "which model did it run on" is a first-class, comparable dimension (no secrets needed for this).
//   2. connection — when scopedSecretsFor is wired, the model's baseUrl + underlying model + API key (from its
//      apiKeySecret, read from the tenant's workspace→personal secret tiers) are injected as env into the agent server's
//      env (command.env / the service that carries the binding), replacing a hand-wired OPENAI_BASE_URL/API_KEY/MODEL combo.
//   3. billing — when the key came from the WORKSPACE secret tier, the workspace paid for those tokens; we record the
//      (id, underlying model) so the dispatcher can stamp it on self-hosted provenance and the meter can bill the
//      workspace for those calls even on an own-pays personal self-hosted run. docs/architecture/usage-metering.md
// String vs object binding: a bare string is best-effort (an unregistered string stays a literal CLI value — legacy
// {{model}}); an explicit ModelRef must resolve (a missing model / a named-but-unset apiKeySecret is a fail-fast 400).

type SecretsFor = (tenant: string, subject?: string) => Promise<ScopedSecretTiers>;

// A workspace-billed model on a run: registered id + its underlying model string (matches TraceEvent.llm_call.model).
export interface BilledModel {
  id: string;
  model: string;
}

// Resolve one binding → the model + the connection env to merge + whether the workspace tier paid for its key.
// undefined = a bare string that is not a registered model (leave the literal in place). Throws BadRequest for an
// explicit ModelRef that can't resolve, or a model whose explicitly named apiKeySecret has no value in either tier.
async function resolveBinding(
  models: ModelRegistry,
  tenant: string,
  submittedBy: string | undefined,
  binding: ModelBinding,
  secretsFor?: SecretsFor,
): Promise<{ model: ModelSpec; env: Record<string, string>; billed?: BilledModel } | undefined> {
  const { ref, version, env: override } = normalizeModelBinding(binding);
  let model: ModelSpec;
  try {
    model = await models.get(tenant, ref, version);
  } catch {
    if (typeof binding === "string") return undefined; // not a registered id → a raw model string (legacy {{model}}).
    throw new BadRequestError(
      "BAD_REQUEST",
      { model: ref },
      `harness references model '${ref}'${version === "latest" ? "" : `@${version}`} but no such model is registered in this workspace.`,
    );
  }
  let apiKey: string | undefined;
  let workspacePaid = false;
  if (secretsFor) {
    const secretName = modelApiKeySecretName(model);
    const scoped = await secretsFor(tenant, submittedBy);
    const fromWorkspace = scoped.workspace[secretName];
    apiKey = fromWorkspace ?? scoped.user[secretName]; // workspace (the team's key) first, personal fallback
    workspacePaid = fromWorkspace !== undefined; // the workspace secret supplied the key → the team pays for these tokens
    if (apiKey === undefined && model.apiKeySecret !== undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { model: ref, secret: secretName },
        `model '${ref}' names apiKeySecret '${secretName}' but no such secret is set (workspace or personal) — set it or drop apiKeySecret.`,
      );
    // apiKeySecret unset + provider-default key absent → run without a key (own-pays / server-side auth), not an error.
  }
  return {
    model,
    env: modelConnectionEnv(model, apiKey, override),
    ...(workspacePaid ? { billed: { id: ref, model: model.model } } : {}),
  };
}

// A binding's CONNECTION ENV alone — for a carrier that is not a HarnessSpec at all (a delegation profile
// pins a model the same way a harness does, but has no spec to rewrite). Same resolver, so "which endpoint,
// which key, under which var names, and who is billed" has one answer everywhere. Unresolvable bare-string
// binding → {} (the legacy best-effort rule); a ModelRef that names nothing still throws.
export async function resolveModelConnectionEnv(
  models: ModelRegistry,
  tenant: string,
  submittedBy: string | undefined,
  binding: ModelBinding,
  secretsFor?: SecretsFor,
): Promise<Record<string, string>> {
  return (await resolveBinding(models, tenant, submittedBy, binding, secretsFor))?.env ?? {};
}

// Resolve a SPEC's Model binding(s) — the per-spec half of the job rewrite, shared with the driver-lane
// session resolver (the playground resolves a harness OUTSIDE any CaseJob). Returns the same spec object
// when nothing changed, so callers can cheaply detect a no-op.
async function resolveSpec(
  models: ModelRegistry,
  tenant: string,
  submittedBy: string | undefined,
  spec: HarnessSpec,
  secretsFor?: SecretsFor,
): Promise<{ spec: HarnessSpec; billed: BilledModel[] }> {
  if (spec.kind === "command") {
    if (spec.model === undefined) return { spec, billed: [] };
    const resolved = await resolveBinding(models, tenant, submittedBy, spec.model, secretsFor);
    if (!resolved) return { spec, billed: [] }; // unregistered raw string — leave the spec untouched.
    const billed = resolved.billed ? [resolved.billed] : [];
    const env = secretsFor ? { ...spec.env, ...resolved.env } : spec.env; // model env wins for the keys it sets
    if (resolved.model.model === spec.model && env === spec.env) return { spec, billed };
    return { spec: { ...spec, model: resolved.model.model, env }, billed };
  }

  if (spec.kind === "service") {
    // Connection injection needs the secret tiers; without them there's nothing to do on a service (no {{model}} slot).
    if (!secretsFor || !spec.services.some((s) => s.model !== undefined)) return { spec, billed: [] };
    const resolvedServices = await Promise.all(
      spec.services.map(async (s) => {
        if (s.model === undefined) return { service: s };
        const resolved = await resolveBinding(models, tenant, submittedBy, s.model, secretsFor);
        if (!resolved) return { service: s };
        return { service: { ...s, env: { ...s.env, ...resolved.env } }, billed: resolved.billed };
      }),
    );
    const services = resolvedServices.map((r) => r.service);
    const billed = resolvedServices.flatMap((r) => (r.billed ? [r.billed] : []));
    return { spec: { ...spec, services }, billed };
  }
  return { spec, billed: [] };
}

// Resolve one harness spec's model binding for a non-dispatch consumer (the sandbox session resolver) —
// same normalization, same connection-env injection, same fail-fast rules as the dispatch path.
export async function resolveSpecModel(
  models: ModelRegistry,
  tenant: string,
  submittedBy: string | undefined,
  spec: HarnessSpec,
  secretsFor?: SecretsFor,
): Promise<HarnessSpec> {
  return (await resolveSpec(models, tenant, submittedBy, spec, secretsFor)).spec;
}

// Resolve a job's harness Model binding(s): the rewritten job + the workspace-billed models used. Without secretsFor,
// only the command {{model}} string is normalized (provenance only, no secret read → no billing signal); with it, the
// connection env is injected into the right env map(s) and workspace-paid models are collected.
async function resolveJob(
  models: ModelRegistry,
  job: CaseJob,
  secretsFor?: SecretsFor,
): Promise<{ job: CaseJob; billed: BilledModel[] }> {
  const spec = job.harnessSpec;
  if (!spec) return { job, billed: [] };
  const tenant = job.tenant ?? "default";
  const resolved = await resolveSpec(models, tenant, job.submittedBy, spec, secretsFor);
  return {
    job: resolved.spec === spec ? job : { ...job, harnessSpec: resolved.spec },
    billed: resolved.billed,
  };
}

// Resolve a job's harness Model binding(s) → the rewritten job (the provenance/connection normalization). The billing
// signal is available via resolveJob; this thin wrapper preserves the pure job-rewrite surface its callers/tests use.
export async function resolveJobModel(models: ModelRegistry, job: CaseJob, secretsFor?: SecretsFor): Promise<CaseJob> {
  return (await resolveJob(models, job, secretsFor)).job;
}

// A Dispatcher decorator that resolves the harness model at a single point right before dispatch. Kept separate from
// RuntimeDispatcher, which is a placement concern — since the run/scorecard/harness-judge paths all share the same
// dispatcher, wrapping in one place means every dispatch runs with the same resolved model + injected connection env,
// and the result provenance ("which model did it run") matches.
export class ModelResolvingDispatcher implements Dispatcher {
  constructor(
    private readonly models: ModelRegistry,
    private readonly inner: Dispatcher,
    private readonly scopedSecretsFor?: SecretsFor,
  ) {}

  async dispatch(job: CaseJob, opts?: DispatchOptions): Promise<CaseResult> {
    const { job: resolved, billed } = await resolveJob(this.models, job, this.scopedSecretsFor);
    const result = await this.inner.dispatch(resolved, opts);
    // Stamp workspace-billed models onto self-hosted provenance so the meter attributes their cost to the workspace
    // even on an own-pays run. A managed run has no provenance and needs no stamp — billingTenant already bills its
    // whole cost to the tenant; we never synthesize provenance (its required ranOn belongs to the execution stamp).
    if (billed.length > 0 && result.provenance)
      return { ...result, provenance: { ...result.provenance, billedModels: billed } };
    return result;
  }
}
