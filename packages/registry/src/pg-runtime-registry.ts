import { ConflictError, NotFoundError, type RuntimeSpec, RuntimeSpecSchema } from "@everdict/core";
import type { SqlClient } from "@everdict/db";
import { SHARED_TENANT, parseVersionTags, resolveRef, sortVersions, specsEqual } from "./registry.js";
import type { RuntimeListEntry, RuntimeRegistry } from "./runtime-registry.js";

interface RuntimeRow {
  runtime: unknown;
}

// Postgres-backed tenant-owned Runtime SSOT. Key (tenant, id, version). Tenant-owned first, else _shared fallback.
// Schema: @everdict/db/migrations/0009_create_runtimes. Same structure as PgJudgeRegistry.
export class PgRuntimeRegistry implements RuntimeRegistry {
  constructor(private readonly client: SqlClient) {}

  private async ownsId(tenant: string, id: string): Promise<boolean> {
    const r = await this.client.query("SELECT 1 FROM everdict_runtimes WHERE tenant = $1 AND id = $2 LIMIT 1", [
      tenant,
      id,
    ]);
    return r.rows.length > 0;
  }
  private async ownerOf(tenant: string, id: string): Promise<string | undefined> {
    if (await this.ownsId(tenant, id)) return tenant;
    if (tenant !== SHARED_TENANT && (await this.ownsId(SHARED_TENANT, id))) return SHARED_TENANT;
    return undefined;
  }
  private async ownerVersions(owner: string, id: string): Promise<string[]> {
    const r = await this.client.query<{ version: string }>(
      "SELECT version FROM everdict_runtimes WHERE tenant = $1 AND id = $2",
      [owner, id],
    );
    return sortVersions(r.rows.map((x) => x.version));
  }

  async register(tenant: string, spec: RuntimeSpec): Promise<void> {
    const existing = await this.client.query<RuntimeRow>(
      "SELECT runtime FROM everdict_runtimes WHERE tenant = $1 AND id = $2 AND version = $3",
      [tenant, spec.id, spec.version],
    );
    const row = existing.rows[0];
    if (row) {
      if (!specsEqual(row.runtime, spec)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: spec.id, version: spec.version },
          `runtime ${spec.id}@${spec.version} is already registered with different content (versions are immutable).`,
        );
      }
      return;
    }
    await this.client.query(
      "INSERT INTO everdict_runtimes (tenant, id, version, runtime, created_at) VALUES ($1, $2, $3, $4, now())",
      [tenant, spec.id, spec.version, JSON.stringify(spec)],
    );
  }

  async has(tenant: string, id: string, version: string): Promise<boolean> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) return false;
    const r = await this.client.query(
      "SELECT 1 FROM everdict_runtimes WHERE tenant = $1 AND id = $2 AND version = $3",
      [owner, id, version],
    );
    return r.rows.length > 0;
  }

  async versions(tenant: string, id: string): Promise<string[]> {
    const owner = await this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id) : [];
  }

  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.ownerVersions(tenant, id);
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<RuntimeSpec> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `runtime '${id}' not found.`);
    const version = resolveRef(id, ref, await this.ownerVersions(owner, id));
    const res = await this.client.query<RuntimeRow>(
      "SELECT runtime FROM everdict_runtimes WHERE tenant = $1 AND id = $2 AND version = $3",
      [owner, id, version],
    );
    return RuntimeSpecSchema.parse((res.rows[0] as RuntimeRow).runtime);
  }

  async list(tenant: string): Promise<RuntimeListEntry[]> {
    const r = await this.client.query<{ id: string }>(
      "SELECT DISTINCT id FROM everdict_runtimes WHERE tenant = $1 OR tenant = $2 ORDER BY id",
      [tenant, SHARED_TENANT],
    );
    const out: RuntimeListEntry[] = [];
    for (const { id } of r.rows) {
      const owner = (await this.ownerOf(tenant, id)) as string;
      const versionTags = await this.versionTags(owner, id);
      out.push({
        id,
        owner,
        versions: await this.ownerVersions(owner, id),
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
      });
    }
    return out;
  }

  // version tag replacement (full-array PUT semantics) — tenant directly-owned versions only (_shared → NotFound). migration 0047.
  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    const r = await this.client.query<{ version: string }>(
      "UPDATE everdict_runtimes SET tags = $4::jsonb WHERE tenant = $1 AND id = $2 AND version = $3 RETURNING version",
      [tenant, id, version, JSON.stringify(tags)],
    );
    if (r.rows.length === 0)
      throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `runtime ${id}@${version} not found.`);
  }

  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) return {};
    const r = await this.client.query<{ version: string; tags: unknown }>(
      "SELECT version, tags FROM everdict_runtimes WHERE tenant = $1 AND id = $2",
      [owner, id],
    );
    const out: Record<string, string[]> = {};
    for (const row of r.rows) {
      const rowTags = parseVersionTags(row.tags);
      if (rowTags.length > 0) out[row.version] = rowTags;
    }
    return out;
  }
}
