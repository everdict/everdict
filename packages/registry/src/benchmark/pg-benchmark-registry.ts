import { type BenchmarkAdapterSpec, BenchmarkAdapterSpecSchema } from "@everdict/datasets";
import type { SqlClient } from "@everdict/db";
import { PgVersionedStore } from "../pg-versioned-store.js";
import type { BenchmarkRegistry } from "./benchmark-registry.js";

// Postgres-backed tenant-owned benchmark recipe SSOT. Key (tenant, id, version). Tenant-owned first, else _shared fallback.
// Schema: @everdict/db/migrations/0011_create_benchmarks — a plain immutable-version table (spec column, no created_by/deleted_at/tags).
// Delegates to the shared PgVersionedStore and exposes only the benchmark surface (no has/softDelete/createdBy/tags).
export class PgBenchmarkRegistry implements BenchmarkRegistry {
  private readonly store: PgVersionedStore<BenchmarkAdapterSpec>;
  constructor(client: SqlClient) {
    this.store = new PgVersionedStore(client, {
      table: "everdict_benchmarks",
      column: "spec",
      label: "Benchmark",
      parse: (v) => BenchmarkAdapterSpecSchema.parse(v),
    });
  }

  register(tenant: string, spec: BenchmarkAdapterSpec): Promise<void> {
    return this.store.register(tenant, spec);
  }
  versions(tenant: string, id: string): Promise<string[]> {
    return this.store.versions(tenant, id);
  }
  ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.store.ownVersions(tenant, id);
  }
  get(tenant: string, id: string, ref?: string): Promise<BenchmarkAdapterSpec> {
    return this.store.get(tenant, id, ref);
  }
  list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    return this.store.listIds(tenant);
  }
}
