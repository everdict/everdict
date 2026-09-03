import type { CapabilityOrigin, HarnessTemplateSpec } from "@everdict/contracts";
import { VersionedStore } from "../versioned-store.js";
export type { HarnessTemplateListEntry } from "@everdict/application-control";

// The registry port lives in @everdict/application-control; this InMemory impl `implements` it, so the registry
// re-exports the port here beside the impl as a deliberate convenience (a consumer imports both together).
export type { HarnessTemplateRegistry } from "@everdict/application-control";
import type { HarnessTemplateListEntry, HarnessTemplateRegistry } from "@everdict/application-control";

// Version meta + what the shape IS, read off its latest version. A shape nothing rides yet appears ONLY in this
// list, so without this it would be a bare id — and the catalog exists precisely to make those visible.
// A version that fails to load degrades to meta-only (the catalog still lists it) — same discipline as the harness list.
export async function enrichTemplateList(
  metas: Array<{ id: string; versions: string[]; owner: string }>,
  getTemplate: (id: string, version: string) => Promise<HarnessTemplateSpec>,
): Promise<HarnessTemplateListEntry[]> {
  const out: HarnessTemplateListEntry[] = [];
  for (const meta of metas) {
    const latestVersion = meta.versions[meta.versions.length - 1];
    let extra: Partial<HarnessTemplateListEntry> = {};
    if (latestVersion !== undefined) {
      try {
        const spec = await getTemplate(meta.id, latestVersion);
        extra = {
          latestVersion,
          kind: spec.kind,
          category: spec.category,
          ...(spec.kind === "service" ? { serviceCount: spec.services.length } : {}),
        };
      } catch {
        extra = { latestVersion };
      }
    }
    out.push({ ...meta, ...extra });
  }
  return out;
}

export class InMemoryHarnessTemplateRegistry implements HarnessTemplateRegistry {
  private readonly store = new VersionedStore<HarnessTemplateSpec>("template");

  async register(
    tenant: string,
    spec: HarnessTemplateSpec,
    createdBy?: string,
    origin?: CapabilityOrigin,
  ): Promise<void> {
    this.store.register(tenant, spec, createdBy, origin);
  }

  async has(tenant: string, id: string, version: string): Promise<boolean> {
    return this.store.has(tenant, id, version);
  }
  async get(tenant: string, id: string, ref?: string): Promise<HarnessTemplateSpec> {
    return this.store.get(tenant, id, ref);
  }
  async versions(tenant: string, id: string): Promise<string[]> {
    return this.store.versions(tenant, id);
  }
  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.store.ownVersions(tenant, id);
  }
  async list(tenant: string): Promise<HarnessTemplateListEntry[]> {
    // listMeta rather than listIds: the owning team rides on the meta, and the read narrows by it.
    return enrichTemplateList(
      this.store.listMeta(tenant).map((m) => ({
        id: m.id,
        versions: m.versions,
        owner: m.owner,
      })),
      (id, version) => this.get(tenant, id, version),
    );
  }
}
