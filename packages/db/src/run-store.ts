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
  // 이 run 이 어느 스코어카드 배치의 자식인지(있으면). scorecard 가 케이스마다 자식 run 을 팬아웃하며 채운다.
  // 미설정 = standalone(단발) run. 활동 리스트는 기본적으로 자식을 숨긴다(범람 방지) → list 옵션 참고.
  parentScorecardId: z.string().optional(),
  // 이 run 이 왜 생겼는지(출처). standalone|scorecard|schedule|mcp|front-door 등 — 활동 뷰의 source 축.
  // dumb 스토어라 값 자체는 검증하지 않는다(자유 문자열). 미설정 = standalone.
  trigger: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

// 읽기 시 result.trace 로부터 usage 요약을 채운다(저장 컬럼 없음 → 항상 트레이스와 일치, 마이그레이션 불필요).
export function withRunUsage(r: RunRecord): RunRecord {
  return r.result ? { ...r, usage: usageFromTrace(r.result.trace) } : r;
}

// list 옵션. 기본(미지정)은 standalone run 만 반환한다 — scorecard 자식 run 을 숨겨 활동 리스트 범람을 막는다.
// scorecardId 지정 시 그 배치의 자식 run 만 반환한다(스코어카드 상세의 케이스 드릴다운용).
export interface RunListOptions {
  scorecardId?: string;
}

// 결과 스토어 계약. in-memory(개발/테스트) 또는 Postgres(운영) — 같은 인터페이스 뒤로 교체.
export interface RunStore {
  create(record: RunRecord): Promise<void>;
  update(id: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined>;
  get(id: string): Promise<RunRecord | undefined>;
  list(tenant?: string, opts?: RunListOptions): Promise<RunRecord[]>;
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

  async list(tenant?: string, opts?: RunListOptions): Promise<RunRecord[]> {
    const all = [...this.runs.values()];
    const scoped = tenant ? all.filter((r) => r.tenant === tenant) : all;
    // scorecardId 지정 → 그 배치 자식만; 아니면 standalone(부모 없는) run 만(자식 숨김).
    const filtered = opts?.scorecardId
      ? scoped.filter((r) => r.parentScorecardId === opts.scorecardId)
      : scoped.filter((r) => r.parentScorecardId == null);
    return filtered.map(withRunUsage);
  }
}
