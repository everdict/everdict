import { type CapabilityOrigin, type RuntimeSpec, RuntimeSpecSchema } from "@everdict/contracts";
import type { SqlClient } from "@everdict/db";
import { PgVersionedStore } from "../pg-versioned-store.js";
import type { RuntimeListEntry, RuntimeRegistry } from "./runtime-registry.js";

// Postgres-backed tenant-owned Runtime SSOT. Key (tenant, id, version). Tenant-owned first, else _shared fallback.
// Schema: @everdict/db/migrations/0009_create_runtimes (+ 0047 tags) — runtime column, tags but no created_by/deleted_at.
// Delegates to the shared PgVersionedStore and exposes the runtime surface (has + list-with-tags + tags; no createdBy/softDelete).
export class PgRuntimeRegistry implements RuntimeRegistry {
  private readonly store: PgVersionedStore<RuntimeSpec>;
  constructor(client: SqlClient) {
    this.store = new PgVersionedStore(client, {
      table: "everdict_runtimes",
      column: "runtime",
      label: "runtime",
      parse: (v) => RuntimeSpecSchema.parse(v),
      teamId: true,
      tags: true,
      origin: true,
    });
  }

  // createdBy/teamId stay unthreaded (the table carries neither column) — the parameters keep the port's positional
  // shape so `origin` lands in the same 5th slot every other registry uses.
  register(
    tenant: string,
    spec: RuntimeSpec,
    _createdBy?: string,
    _teamId?: string,
    origin?: CapabilityOrigin,
  ): Promise<void> {
    return this.store.register(tenant, spec, undefined, undefined, origin);
  }
  // 소유 팀 — 인가 커널의 팀 축이 읽는 값. undefined = 소유자 없음(_shared/시드)이며 "모두의 것"이 아니다.
  teamOfVersion(tenant: string, id: string, version: string): Promise<string | undefined> {
    return this.store.teamOfVersion(tenant, id, version);
  }

  has(tenant: string, id: string, version: string): Promise<boolean> {
    return this.store.has(tenant, id, version);
  }
  versions(tenant: string, id: string): Promise<string[]> {
    return this.store.versions(tenant, id);
  }
  ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.store.ownVersions(tenant, id);
  }
  get(tenant: string, id: string, ref?: string): Promise<RuntimeSpec> {
    return this.store.get(tenant, id, ref);
  }
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    return this.store.setVersionTags(tenant, id, version, tags);
  }
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    return this.store.versionTags(tenant, id);
  }

  // RuntimeListEntry = version summary + version tags + the latest version's declared capabilities (for submit-time fit preview).
  async list(tenant: string): Promise<RuntimeListEntry[]> {
    const out: RuntimeListEntry[] = [];
    for (const { id, owner, versions } of await this.store.listIds(tenant)) {
      const versionTags = await this.store.versionTags(owner, id);
      const capabilities = (await this.store.get(owner, id)).capabilities; // latest (default ref)
      out.push({
        id,
        owner,
        versions,
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
        ...(capabilities && capabilities.length > 0 ? { capabilities } : {}),
      });
    }
    return out;
  }
}
