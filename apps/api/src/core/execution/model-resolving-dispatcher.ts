import type { DispatchOptions, Dispatcher } from "@everdict/backends";
import { BadRequestError, type CaseJob, type CaseResult, type ModelBinding, type ModelSpec } from "@everdict/contracts";
import { modelApiKeySecretName, modelConnectionEnv, normalizeModelBinding } from "@everdict/domain";
import type { ModelRegistry } from "@everdict/registry";
import type { ScopedSecretTiers } from "./judge-auth-dispatcher.js";

// Resolve a harness's Model reference(s) at a single point right before dispatch — the twin of JudgeAuthDispatcher for
// the harness under test. Two things happen from one registered-Model lookup:
//   1. provenance — a command harness's {{model}} slot (its `model` string/ref) becomes the underlying model identifier,
//      so "which model did it run on" is a first-class, comparable dimension (no secrets needed for this).
//   2. connection — when scopedSecretsFor is wired, the model's baseUrl + underlying model + API key (from its
//      apiKeySecret, read from the tenant's workspace→personal secret tiers) are injected as env into the agent server's
//      env (command.env / the service that carries the binding), replacing a hand-wired OPENAI_BASE_URL/API_KEY/MODEL combo.
// String vs object binding: a bare string is best-effort (an unregistered string stays a literal CLI value — legacy
// {{model}}); an explicit ModelRef must resolve (a missing model / a named-but-unset apiKeySecret is a fail-fast 400).

type SecretsFor = (tenant: string, subject?: string) => Promise<ScopedSecretTiers>;

// Resolve one binding → the model + the connection env to merge. undefined = a bare string that is not a registered
// model (leave the literal in place). Throws BadRequest for an explicit ModelRef that can't resolve, or a model whose
// explicitly named apiKeySecret has no value in either secret tier.
async function resolveBinding(
  models: ModelRegistry,
  tenant: string,
  submittedBy: string | undefined,
  binding: ModelBinding,
  secretsFor?: SecretsFor,
): Promise<{ model: ModelSpec; env: Record<string, string> } | undefined> {
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
  if (secretsFor) {
    const secretName = modelApiKeySecretName(model);
    const scoped = await secretsFor(tenant, submittedBy);
    apiKey = scoped.workspace[secretName] ?? scoped.user[secretName]; // workspace (the team's key) first, personal fallback
    if (apiKey === undefined && model.apiKeySecret !== undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { model: ref, secret: secretName },
        `model '${ref}' names apiKeySecret '${secretName}' but no such secret is set (workspace or personal) — set it or drop apiKeySecret.`,
      );
    // apiKeySecret unset + provider-default key absent → run without a key (own-pays / server-side auth), not an error.
  }
  return { model, env: modelConnectionEnv(model, apiKey, override) };
}

// Resolve a job's harness Model binding(s). Without secretsFor, only the command {{model}} string is normalized (provenance
// only, no secret read); with it, the connection env is also injected into the right env map(s).
export async function resolveJobModel(models: ModelRegistry, job: CaseJob, secretsFor?: SecretsFor): Promise<CaseJob> {
  const spec = job.harnessSpec;
  if (!spec) return job;
  const tenant = job.tenant ?? "default";

  if (spec.kind === "command") {
    if (spec.model === undefined) return job;
    const resolved = await resolveBinding(models, tenant, job.submittedBy, spec.model, secretsFor);
    if (!resolved) return job; // unregistered raw string — leave the spec untouched.
    const env = secretsFor ? { ...spec.env, ...resolved.env } : spec.env; // model env wins for the keys it sets
    if (resolved.model.model === spec.model && env === spec.env) return job;
    return { ...job, harnessSpec: { ...spec, model: resolved.model.model, env } };
  }

  if (spec.kind === "service") {
    // Connection injection needs the secret tiers; without them there's nothing to do on a service (no {{model}} slot).
    if (!secretsFor || !spec.services.some((s) => s.model !== undefined)) return job;
    const services = await Promise.all(
      spec.services.map(async (s) => {
        if (s.model === undefined) return s;
        const resolved = await resolveBinding(models, tenant, job.submittedBy, s.model, secretsFor);
        if (!resolved) return s;
        return { ...s, env: { ...s.env, ...resolved.env } };
      }),
    );
    return { ...job, harnessSpec: { ...spec, services } };
  }
  return job;
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
    return this.inner.dispatch(await resolveJobModel(this.models, job, this.scopedSecretsFor), opts);
  }
}
