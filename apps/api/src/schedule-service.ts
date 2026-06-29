import { BadRequestError, NotFoundError } from "@assay/core";
import type { ScheduleOverlapPolicy, ScheduleRecord, ScheduleRunTemplate, ScheduleStore } from "@assay/db";
import type { RunScorecardInput } from "./scorecard-service.js";

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

// Temporal Schedule 로 넘길 최소 사양(드라이버가 cron→Schedule 로 변환). 발사 워크플로 인자는 (tenant, id).
export interface ScheduleSpec {
  id: string;
  tenant: string;
  cron: string;
  timezone: string;
  overlapPolicy: ScheduleOverlapPolicy;
  paused: boolean; // = !enabled
}

// DB↔Temporal 동기화 드라이버(구현=@assay/orchestrator TemporalScheduleDriver). 미주입이면 DB-only(발사 안 함 — dev/Direct).
export interface ScheduleDriver {
  ensure(spec: ScheduleSpec): Promise<void>; // create-or-update(멱등), paused 반영
  remove(id: string): Promise<void>;
}

export interface ScheduleServiceDeps {
  store: ScheduleStore;
  // Temporal 동기화 — 미주입이면 스케줄은 저장/관리만 되고 발사되지 않는다(Temporal 미배포 dev 경로).
  driver?: ScheduleDriver;
  // 발사 시 호출(= ScorecardService.submit). 미주입이면 fire 가 BadRequest(발사 비활성).
  submitScorecard?: (input: RunScorecardInput) => Promise<{ id: string; status: string }>;
  // 발사한 스코어카드 status 폴링(워크플로 poll-to-terminal). 미주입이면 status 라우트 비활성.
  scorecardStatus?: (scorecardId: string) => Promise<string | undefined>;
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

  private specOf(record: ScheduleRecord): ScheduleSpec {
    return {
      id: record.id,
      tenant: record.tenant,
      cron: record.cron,
      timezone: record.timezone,
      overlapPolicy: record.overlapPolicy,
      paused: !record.enabled, // 비활성 스케줄은 Temporal 에서 paused → 발사 안 함
    };
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
    // Temporal 동기화 — 실패 시 DB 레코드를 되돌려 일관성 유지(스케줄이 떴는데 발사 안 되는 상태 방지).
    if (this.deps.driver) {
      try {
        await this.deps.driver.ensure(this.specOf(record));
      } catch (err) {
        await this.deps.store.remove(record.tenant, record.id).catch(() => {});
        throw err;
      }
    }
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
    await this.deps.driver?.ensure(this.specOf(updated)); // cron/타임존/겹침/pause 재동기화
    return updated;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.get(tenant, id); // 존재/소유 확인(404)
    await this.deps.driver?.remove(id); // 먼저 Temporal 에서 제거(발사 중단) — 실패하면 DB 는 그대로 둔다
    await this.deps.store.remove(tenant, id);
  }

  // 발사(Temporal 워크플로가 internal 라우트로 호출) — 스케줄의 runTemplate 을 생성자 신원으로 submit.
  // lastFired/last* 를 기록. 발사기 미설정이면 BadRequest(Temporal 미배포 dev).
  async fire(tenant: string, id: string): Promise<{ scorecardId: string }> {
    const schedule = await this.get(tenant, id); // 404
    if (!this.deps.submitScorecard)
      throw new BadRequestError("BAD_REQUEST", { id }, "스코어카드 발사기가 설정되지 않았습니다(발사 비활성).");
    const t = schedule.runTemplate;
    const rec = await this.deps.submitScorecard({
      tenant,
      submittedBy: schedule.createdBy, // 발사 run = 생성자 신원(예산 → tenant, 비공개-repo 연결 resolve)
      dataset: t.dataset,
      harness: t.harness,
      judges: t.judges,
      metrics: t.metrics,
      ...(t.runtime !== undefined ? { runtime: t.runtime } : {}),
      ...(t.concurrency !== undefined ? { concurrency: t.concurrency } : {}),
    });
    await this.deps.store.update(tenant, id, {
      lastFiredAt: this.now(),
      lastScorecardId: rec.id,
      lastStatus: rec.status,
      updatedAt: this.now(),
    });
    return { scorecardId: rec.id };
  }

  // 발사한 스코어카드 status(워크플로 poll-to-terminal). 미설정이면 undefined.
  scorecardStatus(scorecardId: string): Promise<string | undefined> {
    return this.deps.scorecardStatus?.(scorecardId) ?? Promise.resolve(undefined);
  }
}
