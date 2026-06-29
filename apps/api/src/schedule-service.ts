import { BadRequestError, NotFoundError } from "@assay/core";
import type { ScheduleOverlapPolicy, ScheduleRecord, ScheduleRunTemplate, ScheduleStore } from "@assay/db";

// 5-field cron 의 경량 구조 검증 — 발사(Temporal Schedule, slice 2)가 정밀 파싱을 하므로 여기선 명백한 오형식만 거른다.
// 각 필드: * | n | n-m, 선택 스텝(/k), 콤마 리스트. (값 범위 semantics 는 Temporal 이 강제)
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5 && parts.every((p) => CRON_FIELD.test(p));
}

export interface CreateScheduleInput {
  tenant: string;
  createdBy: string; // 제출자 subject — 발사 run 의 submittedBy(예산 → tenant, 비공개-repo 연결 resolve)
  name: string;
  cron: string;
  timezone?: string; // 기본 "UTC"
  overlapPolicy?: ScheduleOverlapPolicy; // 기본 "skip"
  enabled?: boolean; // 기본 true
  runTemplate: ScheduleRunTemplate;
}

export interface UpdateScheduleInput {
  name?: string;
  cron?: string;
  timezone?: string;
  overlapPolicy?: ScheduleOverlapPolicy;
  enabled?: boolean; // pause/resume
  runTemplate?: ScheduleRunTemplate;
}

export interface ScheduleServiceDeps {
  store: ScheduleStore;
  newId?: () => string;
  now?: () => string;
}

// 예약(cron) 스코어카드 CRUD. 발사(Temporal Schedule 동기화 + 워크플로)는 slice 2 — 여기선 SSOT 레코드만 관리.
// 워크스페이스(tenant) 스코프; AppError 는 그대로 던져 호출부(서버/MCP)가 상태코드로 매핑한다.
// 설계: docs/architecture/scheduled-evals.md.
export class ScheduleService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: ScheduleServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateScheduleInput): Promise<ScheduleRecord> {
    if (!isValidCron(input.cron))
      throw new BadRequestError(
        "BAD_REQUEST",
        { cron: input.cron },
        `cron 식이 올바르지 않습니다(5필드 필요): '${input.cron}'`,
      );
    const ts = this.now();
    const record: ScheduleRecord = {
      id: this.newId(),
      tenant: input.tenant,
      name: input.name,
      cron: input.cron,
      timezone: input.timezone ?? "UTC",
      overlapPolicy: input.overlapPolicy ?? "skip",
      enabled: input.enabled ?? true,
      createdBy: input.createdBy,
      runTemplate: input.runTemplate,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    return record;
  }

  list(tenant: string): Promise<ScheduleRecord[]> {
    return this.deps.store.list(tenant);
  }

  // 워크스페이스 스코프 단건 — 없거나 타 워크스페이스면 404(존재 누출 금지).
  async get(tenant: string, id: string): Promise<ScheduleRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `schedule '${id}' 를 찾을 수 없습니다.`);
    return record;
  }

  async update(tenant: string, id: string, patch: UpdateScheduleInput): Promise<ScheduleRecord> {
    if (patch.cron !== undefined && !isValidCron(patch.cron))
      throw new BadRequestError(
        "BAD_REQUEST",
        { cron: patch.cron },
        `cron 식이 올바르지 않습니다(5필드 필요): '${patch.cron}'`,
      );
    await this.get(tenant, id); // 존재/소유 확인(404)
    const updated = await this.deps.store.update(tenant, id, { ...patch, updatedAt: this.now() });
    if (!updated) throw new NotFoundError("NOT_FOUND", { id }, `schedule '${id}' 를 찾을 수 없습니다.`);
    return updated;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.get(tenant, id); // 존재/소유 확인(404)
    await this.deps.store.remove(tenant, id);
  }
}
