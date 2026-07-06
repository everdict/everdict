import { ConflictError, type JudgeSpec, NotFoundError } from "@assay/core";
import { SHARED_TENANT, compareVersions, resolveRef, specsEqual } from "./registry.js";

// 목록 한 항목 — 버전 메타(등록 이력) + 최신 judge 스펙에서 파생한 표시 필드(kind/provider/model/description).
// GET /judges 와 MCP list_judges 가 이 모양을 낸다. 데이터셋/하니스 ListEntry 와 같은 결.
export interface JudgeListEntry {
  id: string;
  owner: string;
  versions: string[];
  latestVersion: string;
  versionCount: number;
  kind?: string; // model | harness (대분류 역할)
  provider?: string; // model judge: anthropic | openai
  model?: string; // model judge: 모델 id
  description?: string; // judge 설명(스펙 필드)
  subtitle?: string; // provider/model 또는 →harness 요약(목록 부제)
  createdBy?: string; // 최초 등록 버전의 subject(시드/_shared 는 없음)
  createdAt?: string;
  updatedAt?: string;
  versionTags?: Record<string, string[]>; // 버전 → 자유 라벨(태그 있는 버전만) — 가변 레지스트리 메타(스펙 밖)
}

// 최신 JudgeSpec → 목록 파생 필드. model=provider/model, harness=→하니스 위임.
export function judgeDerived(
  spec: JudgeSpec,
): Pick<JudgeListEntry, "kind" | "provider" | "model" | "description" | "subtitle"> {
  if (spec.kind === "model") {
    return {
      kind: "model",
      provider: spec.provider,
      model: spec.model,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      subtitle: `${spec.provider}/${spec.model}`,
    };
  }
  return {
    kind: "harness",
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    subtitle: `→ ${spec.harness.id}`,
  };
}

// Agent Judge 버전 SSOT — (tenant, id, version) → JudgeSpec. 버전 불변. "latest" 는 semver/등록순 최신.
// 하니스/데이터셋과 동일한 소유 모델: 테넌트 소유 우선, 없으면 SHARED_TENANT(first-party 기본 judge) 폴백.
// 유저가 자기 judge(model/harness)를 직접 등록·버전관리한다. async — Postgres 도 같은 계약.
export interface JudgeRegistry {
  register(tenant: string, spec: JudgeSpec, createdBy?: string): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<JudgeSpec>;
  versions(tenant: string, id: string): Promise<string[]>; // 정렬됨(semver 우선) — 소유 우선/_shared 폴백
  ownVersions(tenant: string, id: string): Promise<string[]>; // 이 테넌트가 직접 등록한 버전만(폴백 없음 — 충돌 판정용)
  list(tenant: string): Promise<JudgeListEntry[]>;
  // 버전 태그(자유 라벨, 전체 교체) — 가변 레지스트리 메타(스펙 불변성 밖). 테넌트 소유 버전만; _shared 는 NotFound.
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
  // 버전 → 태그 맵(태그 있는 버전만). 읽기는 versions() 와 동일하게 owner 해석(_shared 폴백 포함).
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>>;
}

interface Entry {
  spec: JudgeSpec;
  seq: number;
  createdAt: string;
  createdBy?: string;
  tags?: string[]; // 버전 태그 — 가변 레지스트리 메타(스펙 불변성 밖, createdBy 와 동급)
}

export class InMemoryJudgeRegistry implements JudgeRegistry {
  private readonly byOwner = new Map<string, Map<string, Map<string, Entry>>>(); // tenant → id → version → Entry
  private seq = 0;

  private ownerVersions(owner: string, id: string): string[] {
    const ids = this.byOwner.get(owner)?.get(id);
    if (!ids) return [];
    return [...ids.values()]
      .sort((a, b) => compareVersions(a.spec.version, b.spec.version) || a.seq - b.seq)
      .map((e) => e.spec.version);
  }
  private ownerOf(tenant: string, id: string): string | undefined {
    if (this.byOwner.get(tenant)?.has(id)) return tenant;
    if (this.byOwner.get(SHARED_TENANT)?.has(id)) return SHARED_TENANT;
    return undefined;
  }

  async register(tenant: string, spec: JudgeSpec, createdBy?: string): Promise<void> {
    let ids = this.byOwner.get(tenant);
    if (!ids) {
      ids = new Map();
      this.byOwner.set(tenant, ids);
    }
    let versions = ids.get(spec.id);
    if (!versions) {
      versions = new Map();
      ids.set(spec.id, versions);
    }
    const existing = versions.get(spec.version);
    if (existing) {
      if (!specsEqual(existing.spec, spec)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: spec.id, version: spec.version },
          `judge ${spec.id}@${spec.version} 가 다른 내용으로 이미 등록되어 있습니다(버전은 불변).`,
        );
      }
      return;
    }
    versions.set(spec.version, {
      spec,
      seq: this.seq++,
      createdAt: new Date().toISOString(),
      ...(createdBy !== undefined ? { createdBy } : {}),
    });
  }

  async has(tenant: string, id: string, version: string): Promise<boolean> {
    const owner = this.ownerOf(tenant, id);
    return owner ? (this.byOwner.get(owner)?.get(id)?.has(version) ?? false) : false;
  }

  async versions(tenant: string, id: string): Promise<string[]> {
    const owner = this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id) : [];
  }

  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.ownerVersions(tenant, id); // 정확히 이 테넌트 소유만(폴백 없음)
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<JudgeSpec> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `judge '${id}' 가 없습니다.`);
    const version = resolveRef(id, ref, this.ownerVersions(owner, id));
    return (this.byOwner.get(owner)?.get(id)?.get(version) as Entry).spec;
  }

  async list(tenant: string): Promise<JudgeListEntry[]> {
    const ids = new Map<string, string>(); // id → owner (테넌트 우선)
    for (const id of this.byOwner.get(SHARED_TENANT)?.keys() ?? []) ids.set(id, SHARED_TENANT);
    for (const id of this.byOwner.get(tenant)?.keys() ?? []) ids.set(id, tenant);
    const out: JudgeListEntry[] = [];
    for (const [id, owner] of [...ids.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const versions = this.ownerVersions(owner, id);
      const latestVersion = versions.at(-1);
      if (latestVersion === undefined) continue;
      const entries = [...(this.byOwner.get(owner)?.get(id)?.values() ?? [])].sort((a, b) => a.seq - b.seq);
      const earliest = entries[0];
      const latest = entries.at(-1);
      const latestSpec = this.byOwner.get(owner)?.get(id)?.get(latestVersion)?.spec;
      const versionTags = await this.versionTags(owner, id);
      out.push({
        id,
        owner,
        versions,
        latestVersion,
        versionCount: versions.length,
        ...(latestSpec ? judgeDerived(latestSpec) : {}),
        ...(earliest?.createdBy !== undefined ? { createdBy: earliest.createdBy } : {}),
        ...(earliest ? { createdAt: earliest.createdAt } : {}),
        ...(latest ? { updatedAt: latest.createdAt } : {}),
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
      });
    }
    return out;
  }

  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    const entry = this.byOwner.get(tenant)?.get(id)?.get(version); // 직접 소유만(폴백 없음 — _shared 는 못 태깅)
    if (!entry) throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `judge ${id}@${version} 가 없습니다.`);
    entry.tags = tags.length > 0 ? tags : undefined; // 빈 배열 = 제거(revive 의 deletedAt=undefined 와 동일 관용)
  }

  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) return {};
    const out: Record<string, string[]> = {};
    for (const e of this.byOwner.get(owner)?.get(id)?.values() ?? []) {
      if (e.tags !== undefined && e.tags.length > 0) out[e.spec.version] = e.tags;
    }
    return out;
  }
}
