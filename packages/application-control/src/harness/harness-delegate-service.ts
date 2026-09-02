import { type DelegateResolution, resolveDelegate } from "@everdict/contracts";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";
import type { HarnessTemplateRegistry } from "../ports/harness-template-registry.js";

// ── WHO MAINTAINS A SLOT'S CODE (docs/architecture/evolution-routing-spec.md §1) ─────────────────────
//
// One service function under two transports (rule `api-layer`): read the instance, read its template, and answer
// with the ONE predicate (`resolveDelegate`, contracts) the build lane and the skill also read. The answer is the
// template's, never this function's — it adds the coordinates a caller needs to act on it and nothing else, so an
// `unmapped` slot reads as "declare a maintainer on template X@Y", not as an opinion about which agent to use.
export interface HarnessDelegateAnswer {
  harness: { id: string; version: string };
  template: { id: string; version: string };
  resolution: DelegateResolution;
}

export async function resolveHarnessDelegate(
  instances: Pick<HarnessInstanceRegistry, "getInstance">,
  templates: Pick<HarnessTemplateRegistry, "get">,
  tenant: string,
  id: string,
  version: string,
  slot?: string,
): Promise<HarnessDelegateAnswer> {
  const instance = await instances.getInstance(tenant, id, version); // missing id/version → NotFoundError
  const template = await templates.get(tenant, instance.template.id, instance.template.version);
  return {
    harness: { id: instance.id, version: instance.version },
    template: { id: instance.template.id, version: instance.template.version },
    resolution: resolveDelegate(template, slot),
  };
}
