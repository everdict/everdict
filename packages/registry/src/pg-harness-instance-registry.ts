import {
  type HarnessInstanceSpec,
  HarnessInstanceSpecSchema,
  type HarnessSpec,
  type ServiceHarnessSpec,
  resolveHarnessInstance,
} from "@everdict/core";
import type { SqlClient } from "@everdict/db";
import {
  type HarnessInstanceRegistry,
  type HarnessListEntry,
  enrichHarnessList,
  resolveInstanceWithPins,
} from "./harness-instance-registry.js";
import type { HarnessTemplateRegistry } from "./harness-template-registry.js";
import { PgVersionedStore } from "./pg-versioned-store.js";
import { asService } from "./registry.js";

// Postgres-backed individual harness (instance) SSOT. Stores HarnessInstanceSpec (template reference + pins), get resolves.
// Schema: @everdict/db/migrations/0016_create_harness_taxonomy. Template resolution via the injected HarnessTemplateRegistry.
export class PgHarnessInstanceRegistry implements HarnessInstanceRegistry {
  private readonly store: PgVersionedStore<HarnessInstanceSpec>;
  constructor(
    client: SqlClient,
    private readonly templates: HarnessTemplateRegistry,
  ) {
    this.store = new PgVersionedStore(client, "everdict_harness_instances", "harness instance", (v) =>
      HarnessInstanceSpecSchema.parse(v),
    );
  }

  async register(tenant: string, instance: HarnessInstanceSpec, createdBy?: string): Promise<void> {
    const template = await this.templates.get(tenant, instance.template.id, instance.template.version);
    resolveHarnessInstance(template, instance); // validate pin validity before register (reject on failure)
    await this.store.register(tenant, instance, createdBy);
  }
  has(tenant: string, id: string, version: string): Promise<boolean> {
    return this.store.has(tenant, id, version);
  }
  creatorOfVersion(tenant: string, id: string, version: string): Promise<string | undefined> {
    return this.store.creatorOfVersion(tenant, id, version);
  }
  softDelete(tenant: string, id: string, version: string): Promise<void> {
    return this.store.softDelete(tenant, id, version);
  }
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    return this.store.setVersionTags(tenant, id, version, tags);
  }
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    return this.store.versionTags(tenant, id);
  }
  getInstance(tenant: string, id: string, ref?: string): Promise<HarnessInstanceSpec> {
    return this.store.get(tenant, id, ref);
  }
  async get(tenant: string, id: string, ref?: string): Promise<HarnessSpec> {
    const instance = await this.store.get(tenant, id, ref);
    const template = await this.templates.get(tenant, instance.template.id, instance.template.version);
    return resolveHarnessInstance(template, instance);
  }
  async resolveWithPins(
    tenant: string,
    id: string,
    ref: string | undefined,
    pins: Record<string, string>,
  ): Promise<HarnessSpec> {
    const instance = await this.store.get(tenant, id, ref);
    const template = await this.templates.get(tenant, instance.template.id, instance.template.version);
    return resolveInstanceWithPins(template, instance, pins);
  }
  async getService(tenant: string, id: string, ref?: string): Promise<ServiceHarnessSpec> {
    return asService(await this.get(tenant, id, ref), id);
  }
  versions(tenant: string, id: string): Promise<string[]> {
    return this.store.versions(tenant, id);
  }
  async creatorOf(tenant: string, id: string): Promise<string | undefined> {
    return (await this.store.listMeta(tenant)).find((m) => m.id === id)?.createdBy;
  }
  async list(tenant: string): Promise<HarnessListEntry[]> {
    return enrichHarnessList(
      await this.store.listMeta(tenant),
      (id, ref) => this.store.get(tenant, id, ref),
      (id, version) => this.templates.get(tenant, id, version),
    );
  }
}
