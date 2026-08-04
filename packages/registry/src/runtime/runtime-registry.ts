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

  // createdBy/teamId stay unthreaded (everdict_runtimes carries neither column) — the parameters exist only to keep
  // the port's positional shape, so `origin` lands in the same 5th slot every other registry uses.
  async register(
    tenant: string,
    spec: RuntimeSpec,
    _createdBy?: string,
    _teamId?: string,
    origin?: CapabilityOrigin,
  ): Promise<void> {
    this.store.register(tenant, spec, undefined, undefined, origin);
  }
  // 소유 팀 — 인가 커널의 팀 축이 읽는 값. undefined = 소유자 없음(_shared/시드)이며 "모두의 것"이 아니다.
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
