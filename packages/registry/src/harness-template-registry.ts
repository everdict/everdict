import type { HarnessTemplateSpec } from "@assay/core";
import { VersionedStore } from "./versioned-store.js";

// 하네스 Template(대분류) 버전 SSOT — (tenant, id, version) → HarnessTemplateSpec. 버전 불변, _shared 폴백.
// 구조(서비스/의존성/슬롯)만 담는다(버전 미고정). 인스턴스는 HarnessInstanceRegistry 가 이 템플릿을 핀해 만든다.
export interface HarnessTemplateRegistry {
  register(tenant: string, spec: HarnessTemplateSpec, createdBy?: string): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<HarnessTemplateSpec>;
  versions(tenant: string, id: string): Promise<string[]>;
  ownVersions(tenant: string, id: string): Promise<string[]>;
  list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>>;
}

export class InMemoryHarnessTemplateRegistry implements HarnessTemplateRegistry {
  private readonly store = new VersionedStore<HarnessTemplateSpec>("템플릿");

  async register(tenant: string, spec: HarnessTemplateSpec, createdBy?: string): Promise<void> {
    this.store.register(tenant, spec, createdBy);
  }
  async has(tenant: string, id: string, version: string): Promise<boolean> {
    return this.store.has(tenant, id, version);
  }
  async get(tenant: string, id: string, ref?: string): Promise<HarnessTemplateSpec> {
    return this.store.get(tenant, id, ref);
  }
  async versions(tenant: string, id: string): Promise<string[]> {
    return this.store.versions(tenant, id);
  }
  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.store.ownVersions(tenant, id);
  }
  async list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    return this.store.listIds(tenant);
  }
}
