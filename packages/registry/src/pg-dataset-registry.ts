import { ConflictError, type Dataset, DatasetSchema, NotFoundError } from "@assay/core";
import type { SqlClient } from "@assay/db";
import type { DatasetListEntry, DatasetRegistry } from "./dataset-registry.js";
import { SHARED_TENANT, resolveRef, sortVersions, specsEqual } from "./registry.js";

interface DatasetRow {
  dataset: unknown;
}

// Postgres 기반 테넌트-소유 데이터셋 SSOT. (tenant, id, version) 키. 테넌트 소유 우선, 없으면 _shared 폴백.
// 스키마: @assay/db/migrations/0005_create_datasets (+ 0018: created_by/deleted_at). PgHarnessRegistry 와 동일 구조.
// 소프트 삭제: deleted_at 이 set 된 행은 모든 read 에서 제외(WHERE deleted_at IS NULL) — 데이터는 보존(재현성).
export class PgDatasetRegistry implements DatasetRegistry {
  constructor(private readonly client: SqlClient) {}

  private async ownsId(tenant: string, id: string): Promise<boolean> {
    const r = await this.client.query(
      "SELECT 1 FROM assay_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL LIMIT 1",
      [tenant, id],
    );
    return r.rows.length > 0;
  }
  private async ownerOf(tenant: string, id: string): Promise<string | undefined> {
    if (await this.ownsId(tenant, id)) return tenant;
    if (tenant !== SHARED_TENANT && (await this.ownsId(SHARED_TENANT, id))) return SHARED_TENANT;
    return undefined;
  }
  private async ownerVersions(owner: string, id: string): Promise<string[]> {
    const r = await this.client.query<{ version: string }>(
      "SELECT version FROM assay_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL",
      [owner, id],
    );
    return sortVersions(r.rows.map((x) => x.version));
  }

  async register(tenant: string, dataset: Dataset, createdBy?: string): Promise<void> {
    // raw 조회 — tombstone 된 슬롯도 본다(버전 identity 는 불변; 같은 내용 재등록은 되살림).
    const existing = await this.client.query<DatasetRow & { deleted_at: string | null }>(
      "SELECT dataset, deleted_at FROM assay_datasets WHERE tenant = $1 AND id = $2 AND version = $3",
      [tenant, dataset.id, dataset.version],
    );
    const row = existing.rows[0];
    if (row) {
      if (!specsEqual(row.dataset, dataset)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: dataset.id, version: dataset.version },
          `데이터셋 ${dataset.id}@${dataset.version} 가 다른 내용으로 이미 등록되어 있습니다(버전은 불변).`,
        );
      }
      if (row.deleted_at !== null)
        await this.client.query(
          "UPDATE assay_datasets SET deleted_at = NULL WHERE tenant = $1 AND id = $2 AND version = $3",
          [tenant, dataset.id, dataset.version],
        ); // 같은 내용 재등록 → 되살림(revive)
      return;
    }
    await this.client.query(
      "INSERT INTO assay_datasets (tenant, id, version, dataset, created_by, created_at) VALUES ($1, $2, $3, $4, $5, now())",
      [tenant, dataset.id, dataset.version, JSON.stringify(dataset), createdBy ?? null],
    );
  }

  async has(tenant: string, id: string, version: string): Promise<boolean> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) return false;
    const r = await this.client.query(
      "SELECT 1 FROM assay_datasets WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
      [owner, id, version],
    );
    return r.rows.length > 0;
  }

  async versions(tenant: string, id: string): Promise<string[]> {
    const owner = await this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id) : [];
  }

  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.ownerVersions(tenant, id); // 정확히 이 테넌트 소유만(폴백 없음), 살아있는 버전만
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<Dataset> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `데이터셋 '${id}' 가 없습니다.`);
    const version = resolveRef(id, ref, await this.ownerVersions(owner, id));
    const res = await this.client.query<DatasetRow>(
      "SELECT dataset FROM assay_datasets WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
      [owner, id, version],
    );
    return DatasetSchema.parse((res.rows[0] as DatasetRow).dataset);
  }

  async list(tenant: string): Promise<DatasetListEntry[]> {
    const r = await this.client.query<{ id: string }>(
      "SELECT DISTINCT id FROM assay_datasets WHERE (tenant = $1 OR tenant = $2) AND deleted_at IS NULL ORDER BY id",
      [tenant, SHARED_TENANT],
    );
    const out: DatasetListEntry[] = [];
    for (const { id } of r.rows) {
      const owner = await this.ownerOf(tenant, id);
      if (owner) out.push(await this.summarize(owner, id)); // owner 는 라이브 DISTINCT id 라 사실상 항상 있음
    }
    return out;
  }

  // 한 id 의 살아있는 버전들을 목록 메타(DatasetListEntry)로 요약. 최신 버전만 파싱해 내용을, created_at 로 생성/수정 시각을 뽑는다.
  private async summarize(owner: string, id: string): Promise<DatasetListEntry> {
    const r = await this.client.query<{
      version: string;
      dataset: unknown;
      created_at: string | Date;
      created_by: string | null;
    }>(
      "SELECT version, dataset, created_at, created_by FROM assay_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL",
      [owner, id],
    );
    const rows = r.rows;
    if (rows.length === 0) throw new NotFoundError("NOT_FOUND", { tenant: owner, id }, `데이터셋 '${id}' 가 없습니다.`);
    const versions = sortVersions(rows.map((x) => x.version));
    const latestVersion = versions.at(-1);
    if (latestVersion === undefined)
      throw new NotFoundError("NOT_FOUND", { tenant: owner, id }, `데이터셋 '${id}' 가 없습니다.`);
    const latestRow = rows.find((x) => x.version === latestVersion);
    if (!latestRow)
      throw new NotFoundError(
        "NOT_FOUND",
        { tenant: owner, id, version: latestVersion },
        `데이터셋 ${id}@${latestVersion} 가 없습니다.`,
      );
    const latest = DatasetSchema.parse(latestRow.dataset);
    const byTime = [...rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const earliest = byTime[0]; // 최초 등록 버전(생성자·생성시각)
    const newest = byTime[byTime.length - 1]; // 최근 등록 버전(수정시각)
    if (!earliest || !newest)
      throw new NotFoundError("NOT_FOUND", { tenant: owner, id }, `데이터셋 '${id}' 가 없습니다.`);
    return {
      id,
      owner,
      versions,
      latestVersion,
      caseCount: latest.cases.length,
      tags: latest.tags,
      createdAt: new Date(earliest.created_at).toISOString(),
      updatedAt: new Date(newest.created_at).toISOString(),
      ...(latest.description !== undefined ? { description: latest.description } : {}),
      ...(latest.producedBy !== undefined ? { producedBy: latest.producedBy } : {}),
      ...(earliest.created_by !== null ? { createdBy: earliest.created_by } : {}),
    };
  }

  async creatorOf(tenant: string, id: string, version: string): Promise<string | undefined> {
    // 이 테넌트 직접 소유 + 살아있는 버전만(폴백 없음 — _shared 는 못 지운다).
    const r = await this.client.query<{ created_by: string | null }>(
      "SELECT created_by FROM assay_datasets WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
      [tenant, id, version],
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `데이터셋 ${id}@${version} 가 없습니다.`);
    return row.created_by ?? undefined;
  }

  async softDelete(tenant: string, id: string, version: string): Promise<void> {
    const r = await this.client.query<{ version: string }>(
      "UPDATE assay_datasets SET deleted_at = now() WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING version",
      [tenant, id, version],
    );
    if (r.rows.length === 0)
      throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `데이터셋 ${id}@${version} 가 없습니다.`);
  }
}
