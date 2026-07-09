import type { DispatchOptions, Dispatcher } from "@everdict/backends";
import type { AgentJob, CaseResult } from "@everdict/core";
import type { ModelRegistry } from "@everdict/registry";

// If a command harness's {{model}} slot (CommandHarnessSpec.model) is a registered Model id, resolve it to that underlying model identifier.
// Same discipline as judge.model resolution — treat a registered Model as a first-class reference, but fall back to the raw model string if no id matches.
// baseUrl/params aren't injected here since the env contract differs per CLI (the harness's command.env governs the base URL).
export async function resolveJobModel(models: ModelRegistry, job: AgentJob): Promise<AgentJob> {
  const spec = job.harnessSpec;
  if (spec?.kind !== "command" || !spec.model) return job;
  const tenant = job.tenant ?? "default";
  let resolved: string;
  try {
    resolved = (await models.get(tenant, spec.model, "latest")).model;
  } catch {
    return job; // not a registered model id → use command.model as-is, as a raw model string.
  }
  if (resolved === spec.model) return job;
  return { ...job, harnessSpec: { ...spec, model: resolved } };
}

// A Dispatcher decorator that resolves the command-harness model at a single point right before dispatch. Kept separate from
// RuntimeDispatcher, which is a placement concern — since the run/scorecard/harness-judge paths all share the same dispatcher,
// wrapping in one place means every dispatch runs with the same resolved model and the result provenance ("which model did it run") matches.
export class ModelResolvingDispatcher implements Dispatcher {
  constructor(
    private readonly models: ModelRegistry,
    private readonly inner: Dispatcher,
  ) {}

  async dispatch(job: AgentJob, opts?: DispatchOptions): Promise<CaseResult> {
    return this.inner.dispatch(await resolveJobModel(this.models, job), opts);
  }
}
