import {
  type HarnessInstanceSpec,
  HarnessInstanceSpecSchema,
  type HarnessSpec,
  type ServiceHarnessSpec,
  resolveHarnessInstance,
} from "@assay/core";
import type { SqlClient } from "@assay/db";
import {
  type HarnessInstanceRegistry,
  type HarnessListEntry,
  enrichHarnessList,
  resolveInstanceWithPins,
} from "./harness-instance-registry.js";
import type { HarnessTemplateRegistry } from "./harness-template-registry.js";
import { PgVersionedStore } from "./pg-versioned-store.js";
import { asService } from "./registry.js";

// Postgres 기반 개별 하네스(Instance) SSOT. 저장은 HarnessInstanceSpec(template 참조+pins), get 은 resolve.
// 스키마: @assay/db/migrations/0016_create_harness_taxonomy. 템플릿 해석은 주입된 HarnessTemplateRegistry.
export class PgHarnessInstanceRegistry implements HarnessInstanceRegistry {
  private readonly store: PgVersionedStore<HarnessInstanceSpec>;
  constructor(
    client: SqlClient,
    private readonly templates: HarnessTemplateRegistry,
  ) {
    this.store = new PgVersionedStore(client, "assay_harness_instances", "하네스 인스턴스", (v) =>
      HarnessInstanceSpecSchema.parse(v),
    );
  }

  async register(tenant: string, instance: HarnessInstanceSpec, createdBy?: string): Promise<void> {
    const template = await this.templates.get(tenant, instance.template.id, instance.template.version);
    resolveHarnessInstance(template, instance); // 등록 전 pins 유효성 검증(실패 시 거부)
    await this.store.register(tenant, instance, createdBy);
  }
  has(tenant: string, id: string, version: string): Promise<boolean> {
    return this.store.has(tenant, id, version);
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
