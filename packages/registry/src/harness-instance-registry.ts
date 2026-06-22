import {
  type HarnessInstanceSpec,
  type HarnessSpec,
  type ServiceHarnessSpec,
  resolveHarnessInstance,
} from "@assay/core";
import type { HarnessTemplateRegistry } from "./harness-template-registry.js";
import { asService } from "./registry.js";
import { VersionedStore } from "./versioned-store.js";

// 개별 하네스(Instance) 레지스트리 — (tenant, id, version) → HarnessInstanceSpec(template 참조 + pins).
// get()/getService() 는 template 을 핀해 resolved HarnessSpec 을 돌려준다(기존 HarnessRegistry.get 과 drop-in 호환).
// 인스턴스는 같은 id(=template.id) 아래 버전으로 쌓인다 → list 가 대분류(템플릿)별로 묶인다.
export interface HarnessInstanceRegistry {
  register(tenant: string, instance: HarnessInstanceSpec): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  getInstance(tenant: string, id: string, ref?: string): Promise<HarnessInstanceSpec>;
  get(tenant: string, id: string, ref?: string): Promise<HarnessSpec>; // resolved (template + pins)
  getService(tenant: string, id: string, ref?: string): Promise<ServiceHarnessSpec>;
  versions(tenant: string, id: string): Promise<string[]>;
  list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>>;
}

export class InMemoryHarnessInstanceRegistry implements HarnessInstanceRegistry {
  private readonly store = new VersionedStore<HarnessInstanceSpec>("하네스 인스턴스");
  constructor(private readonly templates: HarnessTemplateRegistry) {}

  // 등록 시 템플릿 존재 + pins 유효성을 resolve 로 검증(실패하면 등록 거부 — fail fast).
  async register(tenant: string, instance: HarnessInstanceSpec): Promise<void> {
    const template = await this.templates.get(tenant, instance.template.id, instance.template.version);
    resolveHarnessInstance(template, instance); // throws BadRequest on missing/mismatched pins
    this.store.register(tenant, instance);
  }
  async has(tenant: string, id: string, version: string): Promise<boolean> {
    return this.store.has(tenant, id, version);
  }
  async getInstance(tenant: string, id: string, ref?: string): Promise<HarnessInstanceSpec> {
    return this.store.get(tenant, id, ref);
  }
  async get(tenant: string, id: string, ref?: string): Promise<HarnessSpec> {
    const instance = this.store.get(tenant, id, ref);
    const template = await this.templates.get(tenant, instance.template.id, instance.template.version);
    return resolveHarnessInstance(template, instance);
  }
  async getService(tenant: string, id: string, ref?: string): Promise<ServiceHarnessSpec> {
    return asService(await this.get(tenant, id, ref), id);
  }
  async versions(tenant: string, id: string): Promise<string[]> {
    return this.store.versions(tenant, id);
  }
  async list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    return this.store.listIds(tenant);
  }
}
