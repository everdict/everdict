import { BadRequestError, ForbiddenError, NotFoundError } from "@everdict/core";
import type { ScheduleOverlapPolicy, ScheduleRecord, ScheduleRunTemplate, ScheduleStore } from "@everdict/db";
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

// DB↔Temporal 동기화 드라이버(구현=@everdict/orchestrator TemporalScheduleDriver). 미주입이면 DB-only(발사 안 함 — dev/Direct).
export interface ScheduleDriver {
  ensure(spec: ScheduleSpec): Promise<void>; // create-or-update(멱등), paused 반영
  remove(id: string): Promise<void>;
  // 선택: Temporal 이 계산한 다음 발사 시각(authoritative). 한 커넥션으로 여러 id 를 조회 → id별 ISO 배열.
  // 미구현(dev/Direct)이면 서비스가 enrich 를 건너뛰고 웹이 cron 근사로 폴백한다.
  describeMany?(ids: string[]): Promise<Record<string, string[]>>;
}

// 조회 응답 = 저장 레코드 + (드라이버 있으면) Temporal 이 계산한 다음 발사 시각. 비저장 — 읽기 시 부착.
export type ScheduleRecordWithNext = ScheduleRecord & { nextFireTimes?: string[] };

export interface ScheduleServiceDeps {
  store: ScheduleStore;
  // Temporal 동기화 — 미주입이면 스케줄은 저장/관리만 되고 발사되지 않는다(Temporal 미배포 dev 경로).
  driver?: ScheduleDriver;
  // 발사 시 호출(= ScorecardService.submit). 미주입이면 fire 가 BadRequest(발사 비활성).
  submitScorecard?: (input: RunScorecardInput) => Promise<{ id: string; status: string }>;
  // 발사한 스코어카드 status 폴링(워크플로 poll-to-terminal). 미주입이면 status 라우트 비활성.
  scorecardStatus?: (scorecardId: string) => Promise<string | undefined>;
  // 회귀 알림용: 직전↔이번 스코어카드 diff(= ScorecardService.diff). 미완료/오류면 throw → finalize 가 swallow.
  diffScorecards?: (
    tenant: string,
    baselineId: string,
    candidateId: string,
  ) => Promise<{ regressions: RegressionDelta[] }>;
  // 회귀가 잡히면 알림(= NotificationService.notifyRegression). 미주입이면 회귀 알림 비활성(완료 알림은 스코어카드 onComplete).
  notifyRegression?: (tenant: string, payload: RegressionAlert) => Promise<void>;
  newId?: () => string;
  now?: () => string;
}

// diff 의 회귀 1건(케이스×메트릭) — 알림 메시지에 필요한 필드만.
export interface RegressionDelta {
  caseId: string;
  metric: string;
  baseline: number;
  candidate: number;
}
export interface RegressionAlert {
  scheduleName: string;
  scorecardId: string;
  previousScorecardId: string;
  regressions: RegressionDelta[];
  createdBy?: string; // 예약 생성자 — 개인 알림 피드 수신자(notifications N2)
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

  async list(tenant: string): Promise<ScheduleRecordWithNext[]> {
    return this.attachNextFires(await this.deps.store.list(tenant));
  }

  // 워크스페이스 스코프 단건(공개 — API/MCP). 없거나 타 워크스페이스면 404(존재 누출 금지). Temporal 다음 발사 부착.
  async get(tenant: string, id: string): Promise<ScheduleRecordWithNext> {
    const record = await this.getRecord(tenant, id);
    const [enriched] = await this.attachNextFires([record]);
    return enriched ?? record;
  }

  // 내부용 단건(순수 레코드 — Temporal describe 안 함). update/remove/fire/finalize 의 존재·소유 확인·필드 읽기용.
  private async getRecord(tenant: string, id: string): Promise<ScheduleRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `schedule '${id}' 를 찾을 수 없습니다.`);
    return record;
  }

  // 활성 예약에 Temporal 이 계산한 다음 발사 시각(nextFireTimes)을 부착 — 드라이버·describeMany 있을 때만.
  // 한 커넥션으로 일괄 조회. 실패/미구현이면 그대로 반환(웹이 cron 근사로 폴백). 일시중지는 조회 제외(발사 안 함).
  private async attachNextFires(records: ScheduleRecord[]): Promise<ScheduleRecordWithNext[]> {
    const driver = this.deps.driver;
    if (!driver?.describeMany) return records;
    const ids = records.filter((r) => r.enabled).map((r) => r.id);
    if (ids.length === 0) return records;
    const next = await driver.describeMany(ids).catch(() => ({}) as Record<string, string[]>);
    return records.map((r) => (next[r.id]?.length ? { ...r, nextFireTimes: next[r.id] } : r));
  }

  // 수정 — pause/resume(enabled) 는 member+, 내용 편집(이름/cron/타임존/겹침/runTemplate)은 생성자 또는 admin 만.
  // actor 는 호출 경계(라우트/MCP)가 주입한다; 미주입(내부 호출/테스트)이면 소유권 검사를 건너뛴다.
  async update(
    tenant: string,
    id: string,
    patch: UpdateScheduleInput,
    actor?: { subject: string; isAdmin: boolean },
  ): Promise<ScheduleRecord> {
    if (patch.cron !== undefined && !isValidCron(patch.cron))
      throw new BadRequestError(
        "BAD_REQUEST",
        { cron: patch.cron },
        `cron 식이 올바르지 않습니다(5필드 필요): '${patch.cron}'`,
      );
    const existing = await this.getRecord(tenant, id); // 존재/소유 확인(404)
    // enabled 외 필드를 바꾸는 '내용 편집'은 생성자·admin 만(발사가 생성자 신원으로 돌기 때문). pause 는 member+.
    const editsContent = Object.keys(patch).some((k) => k !== "enabled");
    if (editsContent && actor && existing.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "schedules:edit" },
        "이 예약을 수정할 권한이 없습니다(예약 생성자 또는 워크스페이스 admin 만).",
      );
    const updated = await this.deps.store.update(tenant, id, { ...patch, updatedAt: this.now() });
    if (!updated) throw new NotFoundError("NOT_FOUND", { id }, `schedule '${id}' 를 찾을 수 없습니다.`);
    await this.deps.driver?.ensure(this.specOf(updated)); // cron/타임존/겹침/pause 재동기화
    return updated;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.getRecord(tenant, id); // 존재/소유 확인(404)
    await this.deps.driver?.remove(id); // 먼저 Temporal 에서 제거(발사 중단) — 실패하면 DB 는 그대로 둔다
    await this.deps.store.remove(tenant, id);
  }

  // 생성자(createdBy)가 워크스페이스를 떠나면 그 사람이 만든 활성 예약을 일괄 비활성한다 — 발사 run 은 생성자 신원으로
  // 돌아가므로(예산·비공개-repo 연결) 더는 신뢰할 수 없다. Temporal 도 pause(driver.ensure). 멤버 제거 훅에서 호출.
  // 반환 = 비활성된 예약 수.
  async disableByCreator(tenant: string, createdBy: string): Promise<number> {
    const targets = (await this.deps.store.list(tenant)).filter((s) => s.createdBy === createdBy && s.enabled);
    for (const s of targets) {
      const updated = await this.deps.store.update(tenant, s.id, {
        enabled: false,
        lastStatus: "생성자가 워크스페이스를 떠나 자동 비활성",
        updatedAt: this.now(),
      });
      if (updated) await this.deps.driver?.ensure(this.specOf(updated)); // Temporal pause
    }
    return targets.length;
  }

  // 발사(Temporal 워크플로가 internal 라우트로 호출) — 스케줄의 runTemplate 을 생성자 신원으로 submit.
  // lastFired/last* 를 기록하고, 직전 스케줄 run id(이번 발사 직전의 lastScorecardId)를 같이 돌려준다(회귀 비교용).
  // 발사기 미설정이면 BadRequest(Temporal 미배포 dev).
  async fire(tenant: string, id: string): Promise<{ scorecardId: string; previousScorecardId?: string }> {
    const schedule = await this.getRecord(tenant, id); // 404
    if (!this.deps.submitScorecard)
      throw new BadRequestError("BAD_REQUEST", { id }, "스코어카드 발사기가 설정되지 않았습니다(발사 비활성).");
    const previousScorecardId = schedule.lastScorecardId; // 이번 발사 전의 직전 run(finalize 의 회귀 baseline)
    const t = schedule.runTemplate;
    const rec = await this.deps.submitScorecard({
      tenant,
      submittedBy: schedule.createdBy, // 발사 run = 생성자 신원(예산 → tenant, 비공개-repo 연결 resolve)
      origin: { source: "schedule" }, // provenance — 스케줄 발사임을 스탬프
      dataset: t.dataset,
      harness: t.harness,
      judges: t.judges,
      ...(t.runtime !== undefined ? { runtime: t.runtime } : {}),
      ...(t.concurrency !== undefined ? { concurrency: t.concurrency } : {}),
    });
    await this.deps.store.update(tenant, id, {
      lastFiredAt: this.now(),
      lastScorecardId: rec.id,
      lastStatus: rec.status,
      updatedAt: this.now(),
    });
    return { scorecardId: rec.id, ...(previousScorecardId !== undefined ? { previousScorecardId } : {}) };
  }

  // 발사한 스코어카드 status(워크플로 poll-to-terminal). 미설정이면 undefined.
  scorecardStatus(scorecardId: string): Promise<string | undefined> {
    return this.deps.scorecardStatus?.(scorecardId) ?? Promise.resolve(undefined);
  }

  // 종료 처리(워크플로가 poll-to-terminal 후 호출) — 최종 status 를 기록하고, 직전 run 대비 회귀가 있으면 알림.
  // diff 는 둘 다 완료여야 가능(미완료/오류면 throw) → swallow 하고 회귀 알림만 건너뛴다(완료 알림은 스코어카드 onComplete).
  async finalize(tenant: string, id: string, scorecardId: string, previousScorecardId?: string): Promise<void> {
    const schedule = await this.getRecord(tenant, id); // 404(스케줄이 지워졌으면 더 할 일 없음)
    const status = await this.scorecardStatus(scorecardId);
    if (status !== undefined) await this.deps.store.update(tenant, id, { lastStatus: status, updatedAt: this.now() });
    if (!previousScorecardId || !this.deps.diffScorecards || !this.deps.notifyRegression) return;
    let regressions: RegressionDelta[];
    try {
      ({ regressions } = await this.deps.diffScorecards(tenant, previousScorecardId, scorecardId));
    } catch {
      return; // 한쪽이 미완료/실패 → 비교 불가, 회귀 알림 스킵
    }
    if (regressions.length === 0) return;
    await this.deps.notifyRegression(tenant, {
      scheduleName: schedule.name,
      scorecardId,
      previousScorecardId,
      regressions,
      createdBy: schedule.createdBy, // 예약 생성자 → 개인 알림 피드 수신자(notifications N2)
    });
  }
}
