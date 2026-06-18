import { ConflictError, type HarnessSpec, HarnessSpecSchema, type ServiceHarnessSpec } from "@assay/core";
import type { SqlClient } from "@assay/db";
import { type HarnessRegistry, asService, resolveRef, sortVersions, specsEqual } from "./registry.js";

interface HarnessRow {
  id: string;
  version: string;
  spec: unknown; // jsonb → 파싱된 객체
}

// Postgres 기반 하니스 버전 SSOT. InMemory 와 동일한 HarnessRegistry 계약 — 영속화만 다르다.
// 스키마: @assay/db/migrations/0002_create_harnesses.sql (단일 마이그레이터가 적용).
export class PgHarnessRegistry implements HarnessRegistry {
  constructor(private readonly client: SqlClient) {}

  async register(spec: HarnessSpec): Promise<void> {
    const existing = await this.client.query<HarnessRow>(
      "SELECT spec FROM assay_harnesses WHERE id = $1 AND version = $2",
      [spec.id, spec.version],
    );
    const row = existing.rows[0];
    if (row) {
      // 불변성: 동일 스펙이면 멱등, 다르면 충돌(jsonb 키 순서 무관 비교).
      if (!specsEqual(row.spec, spec)) {
        throw new ConflictError(
          "CONFLICT",
          { id: spec.id, version: spec.version },
          `하니스 ${spec.id}@${spec.version} 가 다른 스펙으로 이미 등록되어 있습니다(버전은 불변).`,
        );
      }
      return;
    }
    await this.client.query("INSERT INTO assay_harnesses (id, version, spec, created_at) VALUES ($1, $2, $3, now())", [
      spec.id,
      spec.version,
      JSON.stringify(spec),
    ]);
  }

  async has(id: string, version: string): Promise<boolean> {
    const res = await this.client.query("SELECT 1 FROM assay_harnesses WHERE id = $1 AND version = $2", [id, version]);
    return res.rows.length > 0;
  }

  async versions(id: string): Promise<string[]> {
    const res = await this.client.query<{ version: string }>("SELECT version FROM assay_harnesses WHERE id = $1", [id]);
    return sortVersions(res.rows.map((r) => r.version));
  }

  async get(id: string, ref = "latest"): Promise<HarnessSpec> {
    const version = resolveRef(id, ref, await this.versions(id));
    const res = await this.client.query<HarnessRow>("SELECT spec FROM assay_harnesses WHERE id = $1 AND version = $2", [
      id,
      version,
    ]);
    // resolveRef 통과 → 반드시 존재. jsonb → 계약 검증.
    return HarnessSpecSchema.parse((res.rows[0] as HarnessRow).spec);
  }

  async getService(id: string, ref = "latest"): Promise<ServiceHarnessSpec> {
    return asService(await this.get(id, ref), id);
  }

  async list(): Promise<Array<{ id: string; versions: string[] }>> {
    const res = await this.client.query<{ id: string }>("SELECT DISTINCT id FROM assay_harnesses ORDER BY id");
    const out: Array<{ id: string; versions: string[] }> = [];
    for (const { id } of res.rows) out.push({ id, versions: await this.versions(id) });
    return out;
  }
}
