import { ForbiddenError, NotFoundError } from "@assay/core";
import type { ViewRecord, ViewStore, ViewVisibility } from "@assay/db";

// 저장된 스코어카드 분석 View CRUD. 워크스페이스(tenant) 스코프. 읽기 = 공유 뷰 + 내 비공개; 수정·삭제 = 소유자 또는 admin.
// config 는 웹 AnalysisConfig(불투명) — 컨트롤플레인은 형태를 강제하지 않는다. 설계: docs/architecture/scorecard-analysis-views.md.
export interface CreateViewInput {
  tenant: string;
  createdBy: string;
  name: string;
  config: unknown;
  visibility?: ViewVisibility; // 기본 "private"
}

export interface UpdateViewInput {
  name?: string;
  config?: unknown;
  visibility?: ViewVisibility;
}

export interface ViewServiceDeps {
  store: ViewStore;
  newId?: () => string;
  now?: () => string;
}

export class ViewService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: ViewServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateViewInput): Promise<ViewRecord> {
    const ts = this.now();
    const record: ViewRecord = {
      id: this.newId(),
      tenant: input.tenant,
      name: input.name,
      config: input.config,
      visibility: input.visibility ?? "private",
      createdBy: input.createdBy,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    return record;
  }

  // 내가 볼 수 있는 뷰(공유 + 내 비공개).
  list(tenant: string, subject: string): Promise<ViewRecord[]> {
    return this.deps.store.listVisible(tenant, subject);
  }

  // 단건 — 비공개는 소유자만, 공유는 워크스페이스 누구나. 그 외엔 404(존재 누출 금지).
  async get(tenant: string, id: string, subject: string): Promise<ViewRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record || (record.visibility === "private" && record.createdBy !== subject))
      throw new NotFoundError("NOT_FOUND", { id }, `view '${id}' 를 찾을 수 없습니다.`);
    return record;
  }

  async update(
    tenant: string,
    id: string,
    patch: UpdateViewInput,
    actor: { subject: string; isAdmin: boolean },
  ): Promise<ViewRecord> {
    const existing = await this.getRecord(tenant, id);
    if (existing.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "views:edit" },
        "이 View 를 수정할 권한이 없습니다(소유자 또는 워크스페이스 admin 만).",
      );
    const updated = await this.deps.store.update(tenant, id, { ...patch, updatedAt: this.now() });
    if (!updated) throw new NotFoundError("NOT_FOUND", { id }, `view '${id}' 를 찾을 수 없습니다.`);
    return updated;
  }

  async remove(tenant: string, id: string, actor: { subject: string; isAdmin: boolean }): Promise<void> {
    const existing = await this.getRecord(tenant, id);
    if (existing.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "views:delete" },
        "이 View 를 삭제할 권한이 없습니다(소유자 또는 워크스페이스 admin 만).",
      );
    await this.deps.store.remove(tenant, id);
  }

  // 내부용 단건(가시성 무관) — 소유권 확인/수정·삭제용.
  private async getRecord(tenant: string, id: string): Promise<ViewRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `view '${id}' 를 찾을 수 없습니다.`);
    return record;
  }
}
