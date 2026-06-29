import { z } from "zod";

// 예약(cron) 스코어카드 — 저장된 RunScorecardInput + 크론식 + 정책. 발사는 ScorecardService.submit 을 재사용한다.
// 이 (mutable) 스토어가 SSOT(UI/API 의 진실); Temporal Schedule 은 실행 메커니즘(slice 2). 워크스페이스 스코프.
// 설계: docs/architecture/scheduled-evals.md.
export const ScheduleOverlapPolicySchema = z.enum(["skip", "bufferOne", "allowAll"]);
export type ScheduleOverlapPolicy = z.infer<typeof ScheduleOverlapPolicySchema>;

// 발사 시 ScorecardService.submit 으로 흐를 eval 정의(tenant/submittedBy 는 발사 시점에 스케줄에서 채운다).
export const ScheduleRunTemplateSchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string() }),
  harness: z.object({ id: z.string(), version: z.string() }),
  judges: z.array(z.object({ id: z.string(), version: z.string() })).default([]),
  metrics: z.array(z.object({ id: z.string(), version: z.string() })).default([]),
  runtime: z.string().optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
});
export type ScheduleRunTemplate = z.infer<typeof ScheduleRunTemplateSchema>;

export const ScheduleRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  cron: z.string(), // 5-field cron(검증은 경계에서). timezone 과 함께 Temporal spec 으로 변환(slice 2).
  timezone: z.string(), // IANA tz(예: "Asia/Seoul"). 기본 "UTC".
  overlapPolicy: ScheduleOverlapPolicySchema,
  enabled: z.boolean(),
  createdBy: z.string(), // 생성자 subject — 발사 run 의 submittedBy(예산 → tenant, 비공개-repo 연결 resolve).
  runTemplate: ScheduleRunTemplateSchema,
  lastFiredAt: z.string().optional(),
  lastStatus: z.string().optional(), // 직전 발사 결과(스코어카드 status 또는 에러 사유)
  lastScorecardId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScheduleRecord = z.infer<typeof ScheduleRecordSchema>;

// 스케줄 스토어 계약 — 워크스페이스(tenant) 스코프. in-memory(개발/테스트) 또는 Postgres(운영) 교체.
export interface ScheduleStore {
  create(record: ScheduleRecord): Promise<void>;
  get(tenant: string, id: string): Promise<ScheduleRecord | undefined>;
  list(tenant: string): Promise<ScheduleRecord[]>;
  update(tenant: string, id: string, patch: Partial<ScheduleRecord>): Promise<ScheduleRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}

export class InMemoryScheduleStore implements ScheduleStore {
  private readonly byId = new Map<string, ScheduleRecord>();

  async create(record: ScheduleRecord): Promise<void> {
    this.byId.set(record.id, record);
  }

  async get(tenant: string, id: string): Promise<ScheduleRecord | undefined> {
    const r = this.byId.get(id);
    return r && r.tenant === tenant ? r : undefined; // 타 워크스페이스는 없는 것으로(존재 누출 금지)
  }

  async list(tenant: string): Promise<ScheduleRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.tenant === tenant)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // 최신 먼저
  }

  async update(tenant: string, id: string, patch: Partial<ScheduleRecord>): Promise<ScheduleRecord | undefined> {
    const cur = this.byId.get(id);
    if (!cur || cur.tenant !== tenant) return undefined;
    const next = { ...cur, ...patch, id: cur.id, tenant: cur.tenant }; // id/tenant 는 불변
    this.byId.set(id, next);
    return next;
  }

  async remove(tenant: string, id: string): Promise<void> {
    const cur = this.byId.get(id);
    if (cur && cur.tenant === tenant) this.byId.delete(id);
  }
}
