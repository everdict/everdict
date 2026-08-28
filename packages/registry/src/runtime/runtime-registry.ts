import type { CapabilityOrigin, RuntimeSpec } from "@everdict/contracts";
import { VersionedStore } from "../versioned-store.js";

// The registry port + its list-entry type live in @everdict/application-control; this InMemory impl `implements`
// the port, so the registry re-exports it here beside the impl as a deliberate convenience (import both together).
export type { RuntimeListEntry, RuntimeRegistry } from "@everdict/application-control";
import type { RuntimeListEntry, RuntimeRegistry } from "@everdict/application-control";

// Delegates to the shared VersionedStore and exposes only the runtime surface (has + list-with-tags + tags; no createdBy/softDelete).
// ownerOf is has-live-version (VersionedStore's model) — equivalent to the former id-existence check because runtimes have
// no tombstones (no softDelete → no deleted versions can exist).
export class InMemoryRuntimeRegistry implements RuntimeRegistry {
  private readonly store = new VersionedStore<RuntimeSpec>("runtime");

  // ── THE OWNER IS THREADED, BECAUSE THE PG TWIN THREADS IT (arch-review 119) ─────────────────────
  //
  // This said "everdict_runtimes carries neither column", and migration 0106 gave the table `team_id`. The Pg
  // twin was corrected — its comment records that dropping the owner "left a column that was always NULL and a
  // gate that could never refuse" — and this sibling kept the old body under the old justification.
  //
  // A twin that ignores an argument the real store honours is a guard no unit test can see (rule `testing`):
  // every unit assertion about a runtime's owning team was green against a store that could not hold one, and
  // the `_` prefix was the tell. `createdBy` genuinely stays unthreaded — that column does not exist, so
  // carrying it here would make the in-memory store MORE capable than production, which is the same divergence
  // pointing the other way.
  async register(
    tenant: string,
    spec: RuntimeSpec,
    _createdBy?: string,
    teamId?: string,
    origin?: CapabilityOrigin,
  ): Promise<void> {
    this.store.register(tenant, spec, undefined, teamId, origin);
  }
  // The owning team — the value the authz kernel's team axis reads. Undefined = unowned (_shared/seed),
  // which is NOT the same as "everyone's".
  teamOfVersion(tenant: string, id: string, version: string): string | undefined {
    return this.store.teamOfVersion(tenant, id, version);
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
  async get(tenant: string, id: string, ref?: string): Promise<RuntimeSpec> {
    return this.store.get(tenant, id, ref);
  }
  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    this.store.setVersionTags(tenant, id, version, tags);
  }
  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    return this.store.versionTags(tenant, id);
  }

  // RuntimeListEntry = version summary + version tags + the latest version's declared capabilities (for submit-time fit preview).
  async list(tenant: string): Promise<RuntimeListEntry[]> {
    const out: RuntimeListEntry[] = [];
    for (const { id, owner, versions } of this.store.listIds(tenant)) {
      const versionTags = this.store.versionTags(owner, id);
      // Ownership belongs to the thing, not to one release of it — read it off the newest version.
      const teamId = this.store.teamOfVersion(owner, id, versions[versions.length - 1] ?? "");
      const capabilities = this.store.get(owner, id).capabilities; // latest (default ref)
      out.push({
        id,
        owner,
        versions,
        ...(teamId !== undefined ? { teamId } : {}),
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
        ...(capabilities && capabilities.length > 0 ? { capabilities } : {}),
      });
    }
    return out;
  }
}
