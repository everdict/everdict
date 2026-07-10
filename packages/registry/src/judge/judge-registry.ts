import type { JudgeSpec } from "@everdict/core";
import { VersionedStore } from "../versioned-store.js";

// The port + its list-entry type now live in @everdict/application-control — re-architecture P2d compat re-export (removed in the P4 sweep).
export type { JudgeListEntry, JudgeRegistry } from "@everdict/application-control";
import type { JudgeListEntry, JudgeRegistry } from "@everdict/application-control";

// Latest JudgeSpec → list-derived fields. model=provider/model, harness=→harness delegation.
export function judgeDerived(
  spec: JudgeSpec,
): Pick<JudgeListEntry, "kind" | "provider" | "model" | "description" | "subtitle"> {
  if (spec.kind === "model") {
    return {
      kind: "model",
      provider: spec.provider,
      model: spec.model,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      subtitle: `${spec.provider}/${spec.model}`,
    };
  }
  return {
    kind: "harness",
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    subtitle: `→ ${spec.harness.id}`,
  };
}

// Delegates to the shared VersionedStore and exposes the judge surface (has/ownVersions/rich list/createdBy/tags; NO softDelete).
// ownerOf is has-live-version (VersionedStore's model) — equivalent to the former id-existence check because judges have no
// tombstones (no softDelete → no deleted versions can exist). The list-entry derivation (judgeDerived over the latest spec)
// is the legitimate per-entity part built on top of the shared listMeta.
export class InMemoryJudgeRegistry implements JudgeRegistry {
  private readonly store = new VersionedStore<JudgeSpec>("judge");

  async register(tenant: string, spec: JudgeSpec, createdBy?: string): Promise<void> {
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
  async get(tenant: string, id: string, ref?: string): Promise<JudgeSpec> {
    return this.store.get(tenant, id, ref);
  }
  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    this.store.setVersionTags(tenant, id, version, tags);
  }
  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    return this.store.versionTags(tenant, id);
  }

  async list(tenant: string): Promise<JudgeListEntry[]> {
    const out: JudgeListEntry[] = [];
    for (const meta of this.store.listMeta(tenant)) {
      const latestSpec = this.store.get(meta.owner, meta.id, meta.latestVersion);
      out.push({
        id: meta.id,
        owner: meta.owner,
        versions: meta.versions,
        latestVersion: meta.latestVersion,
        versionCount: meta.versionCount,
        ...judgeDerived(latestSpec),
        ...(meta.createdBy !== undefined ? { createdBy: meta.createdBy } : {}),
        ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
        ...(meta.updatedAt !== undefined ? { updatedAt: meta.updatedAt } : {}),
        ...(meta.versionTags !== undefined ? { versionTags: meta.versionTags } : {}),
      });
    }
    return out;
  }
}
