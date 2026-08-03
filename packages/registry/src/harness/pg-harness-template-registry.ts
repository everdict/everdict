import { type HarnessTemplateSpec, HarnessTemplateSpecSchema } from "@everdict/contracts";
import type { SqlClient } from "@everdict/db";
import { PgVersionedStore } from "../pg-versioned-store.js";
import type { HarnessTemplateRegistry } from "./harness-template-registry.js";

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
      teamId: true,
      tags: true,
    });
  }
  register(tenant: string, spec: HarnessTemplateSpec, createdBy?: string, teamId?: string): Promise<void> {
    return this.store.register(tenant, spec, createdBy, teamId);
  }
  // 소유 팀 — 인가 커널의 팀 축이 읽는 값. undefined = 소유자 없음(_shared/시드)이며 "모두의 것"이 아니다.
  teamOfVersion(tenant: string, id: string, version: string): Promise<string | undefined> {
    return this.store.teamOfVersion(tenant, id, version);
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
