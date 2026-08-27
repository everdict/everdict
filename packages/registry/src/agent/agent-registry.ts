import type { AgentSpec, CapabilityOrigin } from "@everdict/contracts";
import { VersionedStore } from "../versioned-store.js";

// The registry port lives in @everdict/application-control; this InMemory impl `implements` it, so the registry
// re-exports the port here beside the impl as a deliberate convenience (a consumer imports both together).
export type { AgentRegistry } from "@everdict/application-control";
import type { AgentRegistry } from "@everdict/application-control";

// Delegates to the shared VersionedStore and exposes the agent surface (has + createdBy/softDelete; no version tags).
// Agents have tombstones (softDelete), so ownerOf's has-live-version semantics matter — an all-tombstoned id disappears
// from reads, exactly as the shared store implements.
export class InMemoryAgentRegistry implements AgentRegistry {
  private readonly store = new VersionedStore<AgentSpec>("agent");

  async register(
    tenant: string,
    spec: AgentSpec,
    createdBy?: string,
    teamId?: string,
    origin?: CapabilityOrigin,
  ): Promise<void> {
    this.store.register(tenant, spec, createdBy, teamId, origin);
  }

  async registerPreservingOwner(
    tenant: string,
    spec: AgentSpec,
    createdBy?: string,
    origin?: CapabilityOrigin,
  ): Promise<void> {
    this.store.registerPreservingOwner(tenant, spec, createdBy, origin);
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
  async get(tenant: string, id: string, ref?: string): Promise<AgentSpec> {
    return this.store.get(tenant, id, ref);
  }
  async list(tenant: string): Promise<
    Array<{
      id: string;
      versions: string[];
      owner: string;
      createdBy?: string;
      teamId?: string;
      versionOrigins?: Record<string, CapabilityOrigin>;
    }>
  > {
    // The store records the birth stamp; a list that mapped everything BUT it is how an origin dies at a
    // read seam (the registry-facts decorator law, one level down). Forward what the meta carries.
    return this.store.listMeta(tenant).map((m) => ({
      id: m.id,
      versions: m.versions,
      owner: m.owner,
      ...(m.createdBy !== undefined ? { createdBy: m.createdBy } : {}),
      ...(m.teamId !== undefined ? { teamId: m.teamId } : {}),
      ...(m.versionOrigins !== undefined ? { versionOrigins: m.versionOrigins } : {}),
    }));
  }
  async creatorOf(tenant: string, id: string, version: string): Promise<string | undefined> {
    return this.store.creatorOfVersion(tenant, id, version);
  }
  async softDelete(tenant: string, id: string, version: string): Promise<void> {
    this.store.softDelete(tenant, id, version);
  }
}
