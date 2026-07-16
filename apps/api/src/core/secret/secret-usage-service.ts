import type { SecretUsageRef, SecretUsageResponse } from "@everdict/contracts/wire";
import type { SecretStore, WorkspaceSettingsStore } from "@everdict/db";
import { type SecretUsageInputs, collectSecretUsages } from "@everdict/domain";
import type { HarnessInstanceRegistry, ModelRegistry, RuntimeRegistry } from "@everdict/registry";

// Reverse-usage index for workspace secrets — annotates each shared (workspace) secret with the live sites that
// reference it (harness env/trace, runtime cluster/kubeconfig auth, a model's api-key, settings integrations).
// Computed fresh per request from the CURRENT registry specs (latest per entity) + workspace settings — nothing is
// cached, so removing a reference makes it disappear on the next read. Only workspace-scoped secrets/references are
// reported (personal secrets are out of scope: their user-scoped harness refs resolve per-submitter → ambiguous).
// The pure "what references what" scan is collectSecretUsages (@everdict/domain); this service is the I/O around it.

export interface SecretUsageServiceDeps {
  secrets: SecretStore;
  harnesses: HarnessInstanceRegistry;
  models: ModelRegistry;
  runtimes: RuntimeRegistry;
  settings: WorkspaceSettingsStore;
}

export class SecretUsageService {
  constructor(private readonly deps: SecretUsageServiceDeps) {}

  // Every workspace secret + its live reference sites (refs=[] = registered but referenced nowhere = orphan).
  async list(workspace: string): Promise<SecretUsageResponse[]> {
    const [metas, inputs] = await Promise.all([
      this.deps.secrets.list(workspace, ""), // subject="" → shared (workspace) secrets only (owner='')
      this.gatherInputs(workspace),
    ]);
    const byName = new Map<string, SecretUsageRef[]>();
    for (const usage of collectSecretUsages(inputs)) {
      if (usage.scope !== "workspace") continue; // workspace secrets list only
      const refs = byName.get(usage.name);
      if (refs) refs.push(usage.ref);
      else byName.set(usage.name, [usage.ref]);
    }
    return metas
      .filter((m) => m.scope === "workspace")
      .map((m) => ({ name: m.name, updatedAt: m.updatedAt, scope: m.scope, refs: byName.get(m.name) ?? [] }));
  }

  private async gatherInputs(workspace: string): Promise<SecretUsageInputs> {
    const [harnesses, models, runtimes, settings] = await Promise.all([
      this.latestSpecs(this.deps.harnesses.list(workspace), (id) => this.deps.harnesses.get(workspace, id, "latest")),
      this.latestSpecs(this.deps.models.list(workspace), (id) => this.deps.models.get(workspace, id, "latest")),
      this.latestSpecs(this.deps.runtimes.list(workspace), (id) => this.deps.runtimes.get(workspace, id, "latest")),
      this.deps.settings.get(workspace),
    ]);
    return { harnesses, models, runtimes, ...(settings ? { settings } : {}) };
  }

  // Resolve each listed id to its latest spec, skipping any that fail to resolve — an unreadable spec (e.g. a broken
  // template pin) should contribute no references rather than 500 the whole usage view.
  private async latestSpecs<S extends { version: string }>(
    listP: Promise<Array<{ id: string }>>,
    getSpec: (id: string) => Promise<S>,
  ): Promise<Array<{ id: string; version: string; spec: S }>> {
    const list = await listP;
    const resolved = await Promise.all(
      list.map(async (entry) => {
        try {
          const spec = await getSpec(entry.id);
          return { id: entry.id, version: spec.version, spec };
        } catch {
          return undefined; // unreadable spec → no references from it
        }
      }),
    );
    return resolved.filter((x): x is { id: string; version: string; spec: S } => x !== undefined);
  }
}
