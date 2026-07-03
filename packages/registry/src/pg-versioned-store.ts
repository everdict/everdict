import { ConflictError, NotFoundError } from "@assay/core";
import type { SqlClient } from "@assay/db";
import { SHARED_TENANT, resolveRef, sortVersions, specsEqual } from "./registry.js";
import type { VersionMeta } from "./versioned-store.js";

interface SpecRow {
  spec: unknown;
}

// Postgres 버전 (tenant, id, version) → T. _shared 폴백 + latest/semver + 버전 불변. table 은 신뢰된 상수(코드 제공).
// in-memory VersionedStore 의 Pg 짝 — 하네스 taxonomy(템플릿/인스턴스) Pg 레지스트리가 공유한다.
export class PgVersionedStore<T extends { id: string; version: string }> {
  constructor(
    private readonly client: SqlClient,
    private readonly table: string,
    private readonly label: string,
    private readonly parse: (v: unknown) => T,
  ) {}

  private async ownsId(tenant: string, id: string): Promise<boolean> {
    const r = await this.client.query(`SELECT 1 FROM ${this.table} WHERE tenant = $1 AND id = $2 LIMIT 1`, [
      tenant,
      id,
    ]);
    return r.rows.length > 0;
  }
  private async ownerOf(tenant: string, id: string): Promise<string | undefined> {
    if (await this.ownsId(tenant, id)) return tenant;
    if (tenant !== SHARED_TENANT && (await this.ownsId(SHARED_TENANT, id))) return SHARED_TENANT;
    return undefined;
  }
  private async ownerVersions(owner: string, id: string): Promise<string[]> {
    const r = await this.client.query<{ version: string }>(
      `SELECT version FROM ${this.table} WHERE tenant = $1 AND id = $2`,
      [owner, id],
    );
    return sortVersions(r.rows.map((x) => x.version));
  }

  async register(tenant: string, item: T, createdBy?: string): Promise<void> {
    const existing = await this.client.query<SpecRow>(
      `SELECT spec FROM ${this.table} WHERE tenant = $1 AND id = $2 AND version = $3`,
      [tenant, item.id, item.version],
    );
    const row = existing.rows[0];
    if (row) {
      if (!specsEqual(row.spec, item)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: item.id, version: item.version },
          `${this.label} ${item.id}@${item.version} 가 다른 스펙으로 이미 등록되어 있습니다(버전은 불변).`,
        );
      }
      return;
    }
    await this.client.query(
      `INSERT INTO ${this.table} (tenant, id, version, spec, created_at, created_by) VALUES ($1, $2, $3, $4, now(), $5)`,
      [tenant, item.id, item.version, JSON.stringify(item), createdBy ?? null],
    );
  }

  async has(tenant: string, id: string, version: string): Promise<boolean> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) return false;
    const r = await this.client.query(`SELECT 1 FROM ${this.table} WHERE tenant = $1 AND id = $2 AND version = $3`, [
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
    return this.ownerVersions(tenant, id);
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<T> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `${this.label} '${id}' 가 없습니다.`);
    const version = resolveRef(id, ref, await this.ownerVersions(owner, id));
    const res = await this.client.query<SpecRow>(
      `SELECT spec FROM ${this.table} WHERE tenant = $1 AND id = $2 AND version = $3`,
      [owner, id, version],
    );
    return this.parse((res.rows[0] as SpecRow).spec);
  }

  async listIds(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    const r = await this.client.query<{ id: string }>(
      `SELECT DISTINCT id FROM ${this.table} WHERE tenant = $1 OR tenant = $2 ORDER BY id`,
      [tenant, SHARED_TENANT],
    );
    const out: Array<{ id: string; versions: string[]; owner: string }> = [];
    for (const { id } of r.rows) {
      const owner = (await this.ownerOf(tenant, id)) as string;
      out.push({ id, owner, versions: await this.ownerVersions(owner, id) });
    }
    return out;
  }

  // 목록 메타 — id 별 버전 요약 + 등록 이력(최초 subject/시각, 최근 시각). 최신 버전만 파싱하지 않고 메타만 뽑는다.
  async listMeta(tenant: string): Promise<VersionMeta[]> {
    const out: VersionMeta[] = [];
    for (const { id, owner } of await this.listIds(tenant)) {
      const r = await this.client.query<{ version: string; created_at: string | Date; created_by: string | null }>(
        `SELECT version, created_at, created_by FROM ${this.table} WHERE tenant = $1 AND id = $2`,
        [owner, id],
      );
      const versions = sortVersions(r.rows.map((x) => x.version));
      const latestVersion = versions.at(-1);
      if (latestVersion === undefined) continue;
      const byTime = [...r.rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      const earliest = byTime[0];
      const latest = byTime.at(-1);
      out.push({
        id,
        owner,
        versions,
        latestVersion,
        versionCount: versions.length,
        ...(earliest?.created_by != null ? { createdBy: earliest.created_by } : {}),
        ...(earliest ? { createdAt: new Date(earliest.created_at).toISOString() } : {}),
        ...(latest ? { updatedAt: new Date(latest.created_at).toISOString() } : {}),
      });
    }
    return out;
  }
}
