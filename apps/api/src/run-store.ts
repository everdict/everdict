import { CaseResultSchema } from "@assay/core";
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
  error: RunErrorSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

// 결과 스토어 계약. 기본은 in-memory; 운영은 Postgres/ClickHouse 구현으로 교체(같은 인터페이스).
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
    return next;
  }

  async get(id: string): Promise<RunRecord | undefined> {
    return this.runs.get(id);
  }

  async list(tenant?: string): Promise<RunRecord[]> {
    const all = [...this.runs.values()];
    return tenant ? all.filter((r) => r.tenant === tenant) : all;
  }
}
