import { CaseResultSchema, RunUsageSummarySchema, usageFromTrace } from "@assay/core";
import { z } from "zod";

// 한 run 의 수명: 접수 → (스케줄러 큐/디스패치) → 성공/실패. 결과 스토어가 이 레코드를 보관한다.
export const RunStatusSchema = z.enum(["queued", "running", "succeeded", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunErrorSchema = z.object({ code: z.string(), message: z.string() });

export const RunRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  harness: z.object({ id: z.string(), version: z.string() }),
  caseId: z.string(),
  status: RunStatusSchema,
  result: CaseResultSchema.optional(),
  // 사용량 요약 — 저장하지 않고 result.trace 에서 파생(읽을 때 채움). 클라이언트가 트레이스 파싱 없이 토큰/비용 확인.
  usage: RunUsageSummarySchema.optional(),
  error: RunErrorSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

// 읽기 시 result.trace 로부터 usage 요약을 채운다(저장 컬럼 없음 → 항상 트레이스와 일치, 마이그레이션 불필요).
export function withRunUsage(r: RunRecord): RunRecord {
  return r.result ? { ...r, usage: usageFromTrace(r.result.trace) } : r;
}

// 결과 스토어 계약. in-memory(개발/테스트) 또는 Postgres(운영) — 같은 인터페이스 뒤로 교체.
export interface RunStore {
  create(record: RunRecord): Promise<void>;
  update(id: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined>;
  get(id: string): Promise<RunRecord | undefined>;
  list(tenant?: string): Promise<RunRecord[]>;
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();

  async create(record: RunRecord): Promise<void> {
    this.runs.set(record.id, record);
  }

  async update(id: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined> {
    const cur = this.runs.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id };
    this.runs.set(id, next);
    return withRunUsage(next);
  }

  async get(id: string): Promise<RunRecord | undefined> {
    const r = this.runs.get(id);
    return r ? withRunUsage(r) : undefined;
  }

  async list(tenant?: string): Promise<RunRecord[]> {
    const all = [...this.runs.values()];
    return (tenant ? all.filter((r) => r.tenant === tenant) : all).map(withRunUsage);
  }
}
