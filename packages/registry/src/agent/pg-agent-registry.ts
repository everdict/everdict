import { type AgentSpec, AgentSpecSchema, type CapabilityOrigin } from "@everdict/contracts";
import type { SqlClient } from "@everdict/db";
import { PgVersionedStore } from "../pg-versioned-store.js";
import type { AgentRegistry } from "./agent-registry.js";

// Postgres-backed tenant-owned agent SSOT. (tenant, id, version) key. Tenant-owned first, else _shared fallback.
// Schema: @everdict/db/migrations/0070_create_agents (created_by/deleted_at from the start). No version tags column.
// Delegates to the shared PgVersionedStore and exposes the agent surface (has + createdBy/softDelete; no tags).
export class PgAgentRegistry implements AgentRegistry {
  private readonly store: PgVersionedStore<AgentSpec>;
  constructor(client: SqlClient) {
    this.store = new PgVersionedStore(client, {
      table: "everdict_agents",
      column: "spec",
      label: "agent",
      parse: (v) => AgentSpecSchema.parse(v),
      softDelete: true,
      createdBy: true,
      origin: true,
      teamId: true,
    });
  }

  register(
    tenant: string,
    spec: AgentSpec,
    createdBy?: string,
    teamId?: string,
    origin?: CapabilityOrigin,
  ): Promise<void> {
    return this.store.register(tenant, spec, createdBy, teamId, origin);
  }
  // The owner resolved inside the write rather than by the caller (arch-review 77).
  registerPreservingOwner(
    tenant: string,
    spec: AgentSpec,
    createdBy?: string,
    origin?: CapabilityOrigin,
  ): Promise<void> {
    return this.store.registerPreservingOwner(tenant, spec, createdBy, origin);
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
  get(tenant: string, id: string, ref?: string): Promise<AgentSpec> {
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
    // Forward what the meta carries — this twin was dropping teamId AND versionOrigins while the in-memory
    // one dropped only origins: two lists of one port disagreeing about the same read (rule protocol L3).
    return (await this.store.listMeta(tenant)).map((m) => ({
      id: m.id,
      versions: m.versions,
      owner: m.owner,
      ...(m.createdBy !== undefined ? { createdBy: m.createdBy } : {}),
      ...(m.teamId !== undefined ? { teamId: m.teamId } : {}),
      ...(m.versionOrigins !== undefined ? { versionOrigins: m.versionOrigins } : {}),
    }));
  }
  creatorOf(tenant: string, id: string, version: string): Promise<string | undefined> {
    return this.store.creatorOfVersion(tenant, id, version);
  }
  softDelete(tenant: string, id: string, version: string): Promise<void> {
    return this.store.softDelete(tenant, id, version);
  }
}
