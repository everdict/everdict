import { type AgentSpec, AgentSpecSchema } from "@everdict/contracts";
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
    });
  }

  register(tenant: string, spec: AgentSpec, createdBy?: string): Promise<void> {
    return this.store.register(tenant, spec, createdBy);
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
  async list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string; createdBy?: string }>> {
    return (await this.store.listMeta(tenant)).map((m) => ({
      id: m.id,
      versions: m.versions,
      owner: m.owner,
      ...(m.createdBy !== undefined ? { createdBy: m.createdBy } : {}),
    }));
  }
  creatorOf(tenant: string, id: string, version: string): Promise<string | undefined> {
    return this.store.creatorOfVersion(tenant, id, version);
  }
  softDelete(tenant: string, id: string, version: string): Promise<void> {
    return this.store.softDelete(tenant, id, version);
  }
}
