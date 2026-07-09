import { type HarnessTemplateSpec, HarnessTemplateSpecSchema } from "@everdict/core";
import type { SqlClient } from "@everdict/db";
import { PgVersionedStore } from "../pg-versioned-store.js";
import type { HarnessTemplateRegistry } from "./harness-template-registry.js";

// Postgres-backed harness template (category) SSOT. Schema: @everdict/db/migrations/0016_create_harness_taxonomy.
export class PgHarnessTemplateRegistry implements HarnessTemplateRegistry {
  private readonly store: PgVersionedStore<HarnessTemplateSpec>;
  constructor(client: SqlClient) {
    this.store = new PgVersionedStore(client, "everdict_harness_templates", "template", (v) =>
      HarnessTemplateSpecSchema.parse(v),
    );
  }
  register(tenant: string, spec: HarnessTemplateSpec, createdBy?: string): Promise<void> {
    return this.store.register(tenant, spec, createdBy);
  }
  has(tenant: string, id: string, version: string): Promise<boolean> {
    return this.store.has(tenant, id, version);
  }
  get(tenant: string, id: string, ref?: string): Promise<HarnessTemplateSpec> {
    return this.store.get(tenant, id, ref);
  }
  versions(tenant: string, id: string): Promise<string[]> {
    return this.store.versions(tenant, id);
  }
  ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.store.ownVersions(tenant, id);
  }
  list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    return this.store.listIds(tenant);
  }
}
