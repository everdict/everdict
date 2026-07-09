import { ConflictError, NotFoundError } from "@everdict/core";
import { type BenchmarkAdapterSpec, BenchmarkAdapterSpecSchema } from "@everdict/datasets";
import type { SqlClient } from "@everdict/db";
import { SHARED_TENANT, resolveRef, sortVersions, specsEqual } from "../registry.js";
import type { BenchmarkRegistry } from "./benchmark-registry.js";

interface SpecRow {
  spec: unknown;
}

// Postgres-backed tenant-owned benchmark recipe SSOT. Key (tenant, id, version). Tenant-owned first, else _shared fallback.
// Schema: @everdict/db/migrations/0011_create_benchmarks. Same structure as PgDatasetRegistry.
export class PgBenchmarkRegistry implements BenchmarkRegistry {
  constructor(private readonly client: SqlClient) {}

  private async ownsId(tenant: string, id: string): Promise<boolean> {
    const r = await this.client.query("SELECT 1 FROM everdict_benchmarks WHERE tenant = $1 AND id = $2 LIMIT 1", [
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
      "SELECT version FROM everdict_benchmarks WHERE tenant = $1 AND id = $2",
      [owner, id],
    );
    return sortVersions(r.rows.map((x) => x.version));
  }

  async register(tenant: string, spec: BenchmarkAdapterSpec): Promise<void> {
    const existing = await this.client.query<SpecRow>(
      "SELECT spec FROM everdict_benchmarks WHERE tenant = $1 AND id = $2 AND version = $3",
      [tenant, spec.id, spec.version],
    );
    const row = existing.rows[0];
    if (row) {
      if (!specsEqual(row.spec, spec)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: spec.id, version: spec.version },
          `Benchmark ${spec.id}@${spec.version} is already registered with different content (versions are immutable).`,
        );
      }
      return;
    }
    await this.client.query(
      "INSERT INTO everdict_benchmarks (tenant, id, version, spec, created_at) VALUES ($1, $2, $3, $4, now())",
      [tenant, spec.id, spec.version, JSON.stringify(spec)],
    );
  }

  async versions(tenant: string, id: string): Promise<string[]> {
    const owner = await this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id) : [];
  }

  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.ownerVersions(tenant, id);
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<BenchmarkAdapterSpec> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `Benchmark '${id}' not found.`);
    const version = resolveRef(id, ref, await this.ownerVersions(owner, id));
    const res = await this.client.query<SpecRow>(
      "SELECT spec FROM everdict_benchmarks WHERE tenant = $1 AND id = $2 AND version = $3",
      [owner, id, version],
    );
    return BenchmarkAdapterSpecSchema.parse((res.rows[0] as SpecRow).spec);
  }

  async list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    const r = await this.client.query<{ id: string }>(
      "SELECT DISTINCT id FROM everdict_benchmarks WHERE tenant = $1 OR tenant = $2 ORDER BY id",
      [tenant, SHARED_TENANT],
    );
    const out: Array<{ id: string; versions: string[]; owner: string }> = [];
    for (const { id } of r.rows) {
      const owner = (await this.ownerOf(tenant, id)) as string;
      out.push({ id, owner, versions: await this.ownerVersions(owner, id) });
    }
    return out;
  }
}
