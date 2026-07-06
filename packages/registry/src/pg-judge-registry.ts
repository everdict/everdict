import { ConflictError, type JudgeSpec, JudgeSpecSchema, NotFoundError } from "@assay/core";
import type { SqlClient } from "@assay/db";
import { type JudgeListEntry, type JudgeRegistry, judgeDerived } from "./judge-registry.js";
import { SHARED_TENANT, parseVersionTags, resolveRef, sortVersions, specsEqual } from "./registry.js";

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

  async register(tenant: string, spec: JudgeSpec, createdBy?: string): Promise<void> {
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
      "INSERT INTO assay_judges (tenant, id, version, judge, created_at, created_by) VALUES ($1, $2, $3, $4, now(), $5)",
      [tenant, spec.id, spec.version, JSON.stringify(spec), createdBy ?? null],
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

  async list(tenant: string): Promise<JudgeListEntry[]> {
    const r = await this.client.query<{ id: string }>(
      "SELECT DISTINCT id FROM assay_judges WHERE tenant = $1 OR tenant = $2 ORDER BY id",
      [tenant, SHARED_TENANT],
    );
    const out: JudgeListEntry[] = [];
    for (const { id } of r.rows) {
      const owner = (await this.ownerOf(tenant, id)) as string;
      const rows = (
        await this.client.query<{
          version: string;
          created_at: string | Date;
          created_by: string | null;
          judge: unknown;
          tags: unknown;
        }>("SELECT version, created_at, created_by, judge, tags FROM assay_judges WHERE tenant = $1 AND id = $2", [
          owner,
          id,
        ])
      ).rows;
      const versions = sortVersions(rows.map((x) => x.version));
      const latestVersion = versions.at(-1);
      if (latestVersion === undefined) continue;
      const byTime = [...rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      const earliest = byTime[0];
      const latest = byTime.at(-1);
      const latestRow = rows.find((x) => x.version === latestVersion);
      const versionTags: Record<string, string[]> = {};
      for (const row of rows) {
        const rowTags = parseVersionTags(row.tags);
        if (rowTags.length > 0) versionTags[row.version] = rowTags;
      }
      out.push({
        id,
        owner,
        versions,
        latestVersion,
        versionCount: versions.length,
        ...(latestRow ? judgeDerived(JudgeSpecSchema.parse(latestRow.judge)) : {}),
        ...(earliest?.created_by != null ? { createdBy: earliest.created_by } : {}),
        ...(earliest ? { createdAt: new Date(earliest.created_at).toISOString() } : {}),
        ...(latest ? { updatedAt: new Date(latest.created_at).toISOString() } : {}),
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
      });
    }
    return out;
  }

  // 버전 태그 교체(전체 배열 PUT 의미) — 테넌트 직접 소유 버전만(_shared 는 NotFound). 마이그레이션 0047.
  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    const r = await this.client.query<{ version: string }>(
      "UPDATE assay_judges SET tags = $4::jsonb WHERE tenant = $1 AND id = $2 AND version = $3 RETURNING version",
      [tenant, id, version, JSON.stringify(tags)],
    );
    if (r.rows.length === 0)
      throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `judge ${id}@${version} 가 없습니다.`);
  }

  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) return {};
    const r = await this.client.query<{ version: string; tags: unknown }>(
      "SELECT version, tags FROM assay_judges WHERE tenant = $1 AND id = $2",
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
