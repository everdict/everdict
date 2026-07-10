import type { RubricSpec } from "@everdict/contracts";
import { VersionedStore } from "../versioned-store.js";

// The port + its list-entry type now live in @everdict/application-control — re-architecture P2d compat re-export (removed in the P4 sweep).
export type { RubricListEntry, RubricRegistry } from "@everdict/application-control";
import type { RubricListEntry, RubricRegistry } from "@everdict/application-control";

// Latest RubricSpec → list-derived fields. The subtitle names which of the content forms the rubric carries.
export function rubricDerived(spec: RubricSpec): Pick<RubricListEntry, "description" | "subtitle"> {
  const parts: string[] = [];
  if (spec.text) parts.push("text");
  if (spec.criteria?.length) parts.push(`${spec.criteria.length} criteria`);
  if (spec.promptTemplate) parts.push("template");
  return {
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    subtitle: parts.join(" · "),
  };
}

// Delegates to the shared VersionedStore and exposes the rubric surface (has/ownVersions/rich list/createdBy/tags; NO softDelete).
// ownerOf is has-live-version (VersionedStore's model) — equivalent to the former id-existence check because rubrics have no
// tombstones (no softDelete → no deleted versions can exist). rubricDerived over the latest spec is the per-entity part.
export class InMemoryRubricRegistry implements RubricRegistry {
  private readonly store = new VersionedStore<RubricSpec>("rubric");

  async register(tenant: string, spec: RubricSpec, createdBy?: string): Promise<void> {
    this.store.register(tenant, spec, createdBy);
  }
  async has(tenant: string, id: string, version: string): Promise<boolean> {
    return this.store.has(tenant, id, version);
  }
  async versions(tenant: string, id: string): Promise<string[]> {
    return this.store.versions(tenant, id);
  }
  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.store.ownVersions(tenant, id);
  }
  async get(tenant: string, id: string, ref?: string): Promise<RubricSpec> {
    return this.store.get(tenant, id, ref);
  }
  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    this.store.setVersionTags(tenant, id, version, tags);
  }
  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    return this.store.versionTags(tenant, id);
  }

  async list(tenant: string): Promise<RubricListEntry[]> {
    const out: RubricListEntry[] = [];
    for (const meta of this.store.listMeta(tenant)) {
      const latestSpec = this.store.get(meta.owner, meta.id, meta.latestVersion);
      out.push({
        id: meta.id,
        owner: meta.owner,
        versions: meta.versions,
        latestVersion: meta.latestVersion,
        versionCount: meta.versionCount,
        ...rubricDerived(latestSpec),
        ...(meta.createdBy !== undefined ? { createdBy: meta.createdBy } : {}),
        ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
        ...(meta.updatedAt !== undefined ? { updatedAt: meta.updatedAt } : {}),
        ...(meta.versionTags !== undefined ? { versionTags: meta.versionTags } : {}),
      });
    }
    return out;
  }
}
