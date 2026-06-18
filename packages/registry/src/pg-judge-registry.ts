import { ConflictError, type JudgeSpec, JudgeSpecSchema, NotFoundError } from "@assay/core";
import type { SqlClient } from "@assay/db";
import type { JudgeRegistry } from "./judge-registry.js";
import { SHARED_TENANT, resolveRef, sortVersions, specsEqual } from "./registry.js";

interface JudgeRow {
  judge: unknown;
}

// Postgres 기반 테넌트-소유 judge SSOT. (tenant, id, version) 키. 테넌트 소유 우선, 없으면 _shared 폴백.
// 스키마: @assay/db/migrations/0008_create_judges. PgDatasetRegistry 와 동일 구조.
export class PgJudgeRegistry implements JudgeRegistry {
  constructor(private readonly client: SqlClient) {}

  private async ownsId(tenant: string, id: string): Promise<boolean> {
    const r = await this.client.query("SELECT 1 FROM assay_judges WHERE tenant = $1 AND id = $2 LIMIT 1", [tenant, id]);
    return r.rows.length > 0;
  }
  private async ownerOf(tenant: string, id: string): Promise<string | undefined> {
    if (await this.ownsId(tenant, id)) return tenant;
    if (tenant !== SHARED_TENANT && (await this.ownsId(SHARED_TENANT, id))) return SHARED_TENANT;
    return undefined;
  }
  private async ownerVersions(owner: string, id: string): Promise<string[]> {
    const r = await this.client.query<{ version: string }>(
      "SELECT version FROM assay_judges WHERE tenant = $1 AND id = $2",
      [owner, id],
    );
    return sortVersions(r.rows.map((x) => x.version));
  }

  async register(tenant: string, spec: JudgeSpec): Promise<void> {
    const existing = await this.client.query<JudgeRow>(
      "SELECT judge FROM assay_judges WHERE tenant = $1 AND id = $2 AND version = $3",
      [tenant, spec.id, spec.version],
    );
    const row = existing.rows[0];
    if (row) {
      if (!specsEqual(row.judge, spec)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: spec.id, version: spec.version },
          `judge ${spec.id}@${spec.version} 가 다른 내용으로 이미 등록되어 있습니다(버전은 불변).`,
        );
      }
      return;
    }
    await this.client.query(
      "INSERT INTO assay_judges (tenant, id, version, judge, created_at) VALUES ($1, $2, $3, $4, now())",
      [tenant, spec.id, spec.version, JSON.stringify(spec)],
    );
  }

  async has(tenant: string, id: string, version: string): Promise<boolean> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) return false;
    const r = await this.client.query("SELECT 1 FROM assay_judges WHERE tenant = $1 AND id = $2 AND version = $3", [
      owner,
      id,
      version,
    ]);
    return r.rows.length > 0;
  }

  async versions(tenant: string, id: string): Promise<string[]> {
    const owner = await this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id) : [];
  }

  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.ownerVersions(tenant, id); // 정확히 이 테넌트 소유만(폴백 없음)
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<JudgeSpec> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `judge '${id}' 가 없습니다.`);
    const version = resolveRef(id, ref, await this.ownerVersions(owner, id));
    const res = await this.client.query<JudgeRow>(
      "SELECT judge FROM assay_judges WHERE tenant = $1 AND id = $2 AND version = $3",
      [owner, id, version],
    );
    return JudgeSpecSchema.parse((res.rows[0] as JudgeRow).judge);
  }

  async list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    const r = await this.client.query<{ id: string }>(
      "SELECT DISTINCT id FROM assay_judges WHERE tenant = $1 OR tenant = $2 ORDER BY id",
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
