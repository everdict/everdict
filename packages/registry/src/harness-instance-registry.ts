import {
  BadRequestError,
  type HarnessInstanceSpec,
  type HarnessSpec,
  type HarnessTemplateSpec,
  type ServiceHarnessSpec,
  referencesUserSecret,
  resolveHarnessInstance,
} from "@assay/core";
import type { HarnessTemplateRegistry } from "./harness-template-registry.js";
import { asService } from "./registry.js";
import { type VersionMeta, VersionedStore } from "./versioned-store.js";

// 목록 한 항목 — 버전 메타(등록 이력) + 최신 인스턴스에서 파생한 표시 필드(category/kind/subtitle).
// GET /harnesses 와 MCP list_harnesses 가 이 모양을 낸다. 데이터셋 DatasetListEntry 와 같은 결.
export interface HarnessListEntry extends VersionMeta {
  category?: string; // 최신 인스턴스의 템플릿 대분류(cli-agent 등)
  kind?: string; // command | service | process (resolved)
  subtitle?: string; // 모델/커맨드/서비스 요약(하니스는 free-text description 이 없어 이걸 부제로 쓴다)
  // 최신 인스턴스가 개인(user) 스코프 시크릿을 참조하면 true — 이 하니스는 createdBy 만 볼 수 있다(비공개).
  // API 가 이 값 + createdBy 로 목록/상세에서 다른 유저에게 숨긴다(값 자체는 파생 — 별도 저장 없음).
  private?: boolean;
}

// resolved HarnessSpec → 부제(목록 표시용). command=모델/커맨드, service=서비스 수. 없으면 undefined.
export function harnessSubtitle(spec: HarnessSpec): string | undefined {
  if (spec.kind === "command") return spec.model ?? spec.command;
  if (spec.kind === "service") return `${spec.services.length}개 서비스`;
  return undefined;
}

// 목록 메타에 최신 인스턴스 파생(category/kind/subtitle)을 얹는다. 템플릿 누락 등은 조용히 생략(목록은 계속 뜬다).
export async function enrichHarnessList(
  metas: VersionMeta[],
  getInstance: (id: string, ref: string) => Promise<HarnessInstanceSpec>,
  getTemplate: (id: string, version: string) => Promise<HarnessTemplateSpec>,
): Promise<HarnessListEntry[]> {
  const out: HarnessListEntry[] = [];
  for (const meta of metas) {
    let extra: Partial<Pick<HarnessListEntry, "category" | "kind" | "subtitle" | "private">> = {};
    try {
      const instance = await getInstance(meta.id, meta.latestVersion);
      const template = await getTemplate(instance.template.id, instance.template.version);
      const resolved = resolveHarnessInstance(template, instance);
      const sub = harnessSubtitle(resolved);
      extra = {
        category: template.category,
        kind: resolved.kind,
        private: referencesUserSecret(resolved),
        ...(sub !== undefined ? { subtitle: sub } : {}),
      };
    } catch {
      // 템플릿 누락/해석 실패 — 파생 필드 생략(메타만 노출)
    }
    out.push({ ...meta, ...extra });
  }
  return out;
}

// 템플릿이 핀 가능한 슬롯 키 — service: slot(미지정이면 name), command: image/model, process: 없음.
function templateSlots(template: HarnessTemplateSpec): string[] {
  if (template.kind === "service") return template.services.map((s) => s.slot ?? s.name);
  if (template.kind === "command") return ["image", "model"];
  return [];
}

// 제출 시점 임시 핀 오버라이드 — 인스턴스 pins 위에 병합해 resolve(레지스트리 무변경, PR 이미지 스왑용).
// 알 수 없는 슬롯은 BadRequest — 오타를 조용히 무시하면 PR 이미지가 안 갈아끼워진 채 평가가 통과하는 사고가 된다.
export function resolveInstanceWithPins(
  template: HarnessTemplateSpec,
  instance: HarnessInstanceSpec,
  pins: Record<string, string>,
): HarnessSpec {
  const known = new Set(templateSlots(template));
  for (const slot of Object.keys(pins)) {
    if (!known.has(slot)) {
      throw new BadRequestError("BAD_REQUEST", { slot, known: [...known] }, `핀 슬롯 '${slot}' 가 템플릿에 없습니다.`);
    }
  }
  return resolveHarnessInstance(template, { ...instance, pins: { ...instance.pins, ...pins } });
}

// 개별 하네스(Instance) 레지스트리 — (tenant, id, version) → HarnessInstanceSpec(template 참조 + pins).
// get()/getService() 는 template 을 핀해 resolved HarnessSpec 을 돌려준다(기존 HarnessRegistry.get 과 drop-in 호환).
// 인스턴스는 같은 id(=template.id) 아래 버전으로 쌓인다 → list 가 대분류(템플릿)별로 묶인다.
export interface HarnessInstanceRegistry {
  register(tenant: string, instance: HarnessInstanceSpec, createdBy?: string): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  getInstance(tenant: string, id: string, ref?: string): Promise<HarnessInstanceSpec>;
  get(tenant: string, id: string, ref?: string): Promise<HarnessSpec>; // resolved (template + pins)
  // resolved + 제출 시점 임시 핀(레지스트리 무변경) — CI PR 발사가 한 서비스 이미지만 스왑해 평가할 때.
  resolveWithPins(
    tenant: string,
    id: string,
    ref: string | undefined,
    pins: Record<string, string>,
  ): Promise<HarnessSpec>;
  getService(tenant: string, id: string, ref?: string): Promise<ServiceHarnessSpec>;
  versions(tenant: string, id: string): Promise<string[]>;
  list(tenant: string): Promise<HarnessListEntry[]>;
  // 이 하니스 id 의 최초 등록자 subject(시드/공유는 없음) — 비공개(개인 시크릿 참조) 하니스의 소유자 확인용.
  creatorOf(tenant: string, id: string): Promise<string | undefined>;
  // 이 "버전"의 등록자 subject — 삭제 authz(생성자-또는-admin)용. 비소유/삭제/부재 → NotFound(데이터셋과 동일).
  creatorOfVersion(tenant: string, id: string, version: string): Promise<string | undefined>;
  // 버전 소프트 삭제(tombstone) — 데이터는 보존(과거 스코어카드 재현성), 모든 read 에서 제외, 동일 내용 재등록은 부활.
  softDelete(tenant: string, id: string, version: string): Promise<void>;
  // 버전 태그(자유 라벨, 전체 교체) — 가변 레지스트리 메타(스펙 불변성 밖). 테넌트 소유 살아있는 버전만; _shared 는 NotFound.
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
  // 버전 → 태그 맵(태그 있는 버전만). 읽기는 versions() 와 동일하게 owner 해석(_shared 폴백 포함).
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>>;
}

export class InMemoryHarnessInstanceRegistry implements HarnessInstanceRegistry {
  private readonly store = new VersionedStore<HarnessInstanceSpec>("하네스 인스턴스");
  constructor(private readonly templates: HarnessTemplateRegistry) {}

  // 등록 시 템플릿 존재 + pins 유효성을 resolve 로 검증(실패하면 등록 거부 — fail fast).
  async register(tenant: string, instance: HarnessInstanceSpec, createdBy?: string): Promise<void> {
    const template = await this.templates.get(tenant, instance.template.id, instance.template.version);
    resolveHarnessInstance(template, instance); // throws BadRequest on missing/mismatched pins
    this.store.register(tenant, instance, createdBy);
  }
  async has(tenant: string, id: string, version: string): Promise<boolean> {
    return this.store.has(tenant, id, version);
  }
  async creatorOfVersion(tenant: string, id: string, version: string): Promise<string | undefined> {
    return this.store.creatorOfVersion(tenant, id, version);
  }
  async softDelete(tenant: string, id: string, version: string): Promise<void> {
    this.store.softDelete(tenant, id, version);
  }
  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    this.store.setVersionTags(tenant, id, version, tags);
  }
  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    return this.store.versionTags(tenant, id);
  }
  async getInstance(tenant: string, id: string, ref?: string): Promise<HarnessInstanceSpec> {
    return this.store.get(tenant, id, ref);
  }
  async get(tenant: string, id: string, ref?: string): Promise<HarnessSpec> {
    const instance = this.store.get(tenant, id, ref);
    const template = await this.templates.get(tenant, instance.template.id, instance.template.version);
    return resolveHarnessInstance(template, instance);
  }
  async resolveWithPins(
    tenant: string,
    id: string,
    ref: string | undefined,
    pins: Record<string, string>,
  ): Promise<HarnessSpec> {
    const instance = this.store.get(tenant, id, ref);
    const template = await this.templates.get(tenant, instance.template.id, instance.template.version);
    return resolveInstanceWithPins(template, instance, pins);
  }
  async getService(tenant: string, id: string, ref?: string): Promise<ServiceHarnessSpec> {
    return asService(await this.get(tenant, id, ref), id);
  }
  async versions(tenant: string, id: string): Promise<string[]> {
    return this.store.versions(tenant, id);
  }
  async creatorOf(tenant: string, id: string): Promise<string | undefined> {
    return this.store.listMeta(tenant).find((m) => m.id === id)?.createdBy;
  }
  async list(tenant: string): Promise<HarnessListEntry[]> {
    return enrichHarnessList(
      this.store.listMeta(tenant),
      (id, ref) => Promise.resolve(this.store.get(tenant, id, ref)),
      (id, version) => this.templates.get(tenant, id, version),
    );
  }
}
