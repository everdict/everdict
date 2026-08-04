import type { CapabilityOrigin, HarnessTemplateSpec } from "@everdict/contracts";
import { VersionedStore } from "../versioned-store.js";

// The registry port lives in @everdict/application-control; this InMemory impl `implements` it, so the registry
// re-exports the port here beside the impl as a deliberate convenience (a consumer imports both together).
export type { HarnessTemplateRegistry } from "@everdict/application-control";
import type { HarnessTemplateRegistry } from "@everdict/application-control";

export class InMemoryHarnessTemplateRegistry implements HarnessTemplateRegistry {
  private readonly store = new VersionedStore<HarnessTemplateSpec>("template");

  async register(
    tenant: string,
    spec: HarnessTemplateSpec,
    createdBy?: string,
    teamId?: string,
    origin?: CapabilityOrigin,
  ): Promise<void> {
    this.store.register(tenant, spec, createdBy, teamId, origin);
  }
  // 소유 팀 — 인가 커널의 팀 축이 읽는 값. undefined = 소유자 없음(_shared/시드)이며 "모두의 것"이 아니다.
  teamOfVersion(tenant: string, id: string, version: string): string | undefined {
    return this.store.teamOfVersion(tenant, id, version);
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
  async list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string; teamId?: string }>> {
    // listMeta rather than listIds: the owning team rides on the meta, and the read narrows by it.
    return this.store.listMeta(tenant).map((m) => ({
      id: m.id,
      versions: m.versions,
      owner: m.owner,
      ...(m.teamId !== undefined ? { teamId: m.teamId } : {}),
    }));
  }
}
