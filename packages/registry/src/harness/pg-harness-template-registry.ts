import type { HarnessTemplateListEntry } from "@everdict/application-control";
import { type CapabilityOrigin, type HarnessTemplateSpec, HarnessTemplateSpecSchema } from "@everdict/contracts";
import type { SqlClient } from "@everdict/db";
import { PgVersionedStore } from "../pg-versioned-store.js";
import { type HarnessTemplateRegistry, enrichTemplateList } from "./harness-template-registry.js";

// Postgres-backed harness template (category) SSOT. Schema: @everdict/db/migrations/0016_create_harness_taxonomy.
export class PgHarnessTemplateRegistry implements HarnessTemplateRegistry {
  private readonly store: PgVersionedStore<HarnessTemplateSpec>;
  constructor(client: SqlClient) {
    this.store = new PgVersionedStore(client, {
      table: "everdict_harness_templates",
      column: "spec",
      label: "template",
      parse: (v) => HarnessTemplateSpecSchema.parse(v),
      softDelete: true,
      createdBy: true,
      tags: true,
      origin: true,
    });
  }
  register(tenant: string, spec: HarnessTemplateSpec, createdBy?: string, origin?: CapabilityOrigin): Promise<void> {
    return this.store.register(tenant, spec, createdBy, origin);
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
  async list(tenant: string): Promise<HarnessTemplateListEntry[]> {
    // listMeta rather than listIds: the owning team rides on the meta, and the read narrows by it.
    return enrichTemplateList(
      (await this.store.listMeta(tenant)).map((m) => ({
        id: m.id,
        versions: m.versions,
        owner: m.owner,
      })),
      (id, version) => this.get(tenant, id, version),
    );
  }
}
