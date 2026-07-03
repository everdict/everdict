import type { RunStore, ScorecardStore } from "@assay/db";
import type { ScheduleRecordWithNext } from "./schedule-service.js";

// 작업 큐 스냅샷 — "지금 무엇이 어디(런타임)에서 돌고/기다리고, 다음은 무엇인가"를 한 화면으로.
// 단위는 배치=1작업(스코어카드, 진행률 포함) + 단발 run=1작업 (자식 run 은 배치의 진행률로 접힘 — 디자인 결정).
// 레인 = 런타임: '' = 기본 백엔드, 'self:<runnerId>' = 셀프호스티드 러너, 그 외 = 등록 런타임 id.
// 설계: docs/architecture/work-queue.md.

export interface QueueItem {
  type: "scorecard" | "run";
  id: string;
  status: "queued" | "running";
  dataset?: { id: string; version: string }; // 스코어카드만
  harness: { id: string; version: string };
  caseId?: string; // 단발 run 만
  trigger?: string; // 어디서 발사됐나(web|api|schedule|scorecard…) — run 은 trigger, 스코어카드는 origin.source
  createdBy?: string; // 실행자 subject(있으면)
  createdAt: string;
  // 배치 진행률(실행 중 스코어카드만) — done=종결(성공+실패) 자식, active=실행 중 자식,
  // total=데이터셋 케이스 수(해석 실패 시 생략 → UI 는 done/active 만 표시).
  progress?: { done: number; active: number; total?: number };
}

export interface QueueUpcoming {
  scheduleId: string;
  name: string;
  at: string; // 다음 발사 시각(ISO, Temporal authoritative) — 없으면 항목 자체를 생략
  dataset: string;
  harness: string;
}

export interface QueueLane {
  runtime: string; // '' = 기본 백엔드
  registered: boolean; // 런타임 레지스트리에 등록된 레인인지(기본/셀프/삭제됨 구분용)
  running: QueueItem[]; // 실행 중 — 오래된 것부터
  queued: QueueItem[]; // 대기 — FIFO(맨 앞이 다음 작업)
  upcoming: QueueUpcoming[]; // 이 레인을 겨냥한 활성 예약의 다음 발사(임박순)
}

export interface QueueSnapshot {
  generatedAt: string;
  totals: { running: number; queued: number; upcoming: number };
  lanes: QueueLane[];
}

export interface QueueServiceDeps {
  scorecards: ScorecardStore;
  runs?: RunStore; // 단발 run 항목 + 배치 진행률(자식 카운트). 미설정이면 스코어카드만.
  schedules?: { list(tenant: string): Promise<ScheduleRecordWithNext[]> }; // 다음 발사(upcoming)
  runtimes?: { list(tenant: string): Promise<Array<{ id: string }>> }; // 등록 런타임 → 빈 레인도 노출
  // 배치 진행률의 total(데이터셋 케이스 수) 해석 — 실패하면 생략(진행률은 자식 수로만 표시).
  caseCountFor?: (tenant: string, datasetId: string, version: string) => Promise<number | undefined>;
  upcomingPerLane?: number;
  now?: () => string;
}

const ACTIVE = new Set(["queued", "running"]);

export class QueueService {
  private readonly now: () => string;
  private readonly upcomingPerLane: number;

  constructor(private readonly deps: QueueServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.upcomingPerLane = deps.upcomingPerLane ?? 5;
  }

  async snapshot(tenant: string): Promise<QueueSnapshot> {
    const [cards, runs, schedules, runtimes] = await Promise.all([
      this.deps.scorecards.list(tenant),
      this.deps.runs ? this.deps.runs.list(tenant) : Promise.resolve([]),
      this.deps.schedules ? this.deps.schedules.list(tenant).catch(() => []) : Promise.resolve([]),
      this.deps.runtimes ? this.deps.runtimes.list(tenant).catch(() => []) : Promise.resolve([]),
    ]);

    const activeCards = cards.filter((c) => ACTIVE.has(c.status));
    // runs.list 기본은 standalone 만 — 배치 자식은 부모의 진행률로 접힌다(중복 계상 방지).
    const activeRuns = runs.filter((r) => ACTIVE.has(r.status));

    // 실행 중 배치의 진행률 — 자식 run 카운트(+ 데이터셋 케이스 수 total, 해석 실패 시 생략).
    const progressOf = new Map<string, QueueItem["progress"]>();
    await Promise.all(
      activeCards
        .filter((c) => c.status === "running")
        .map(async (c) => {
          const children = this.deps.runs ? await this.deps.runs.list(tenant, { scorecardId: c.id }) : [];
          const done = children.filter((r) => r.status === "succeeded" || r.status === "failed").length;
          const active = children.filter((r) => r.status === "running").length;
          const total = this.deps.caseCountFor
            ? await this.deps.caseCountFor(tenant, c.dataset.id, c.dataset.version).catch(() => undefined)
            : undefined;
          progressOf.set(c.id, { done, active, ...(total !== undefined ? { total } : {}) });
        }),
    );

    const items: Array<{ lane: string; item: QueueItem }> = [
      ...activeCards.map((c) => ({
        lane: c.runtime ?? "",
        item: {
          type: "scorecard" as const,
          id: c.id,
          status: c.status as "queued" | "running",
          dataset: c.dataset,
          harness: c.harness,
          ...(c.origin?.source ? { trigger: c.origin.source } : {}),
          ...(c.createdBy ? { createdBy: c.createdBy } : {}),
          createdAt: c.createdAt,
          ...(progressOf.has(c.id) ? { progress: progressOf.get(c.id) } : {}),
        },
      })),
      ...activeRuns.map((r) => ({
        lane: r.runtime ?? "",
        item: {
          type: "run" as const,
          id: r.id,
          status: r.status as "queued" | "running",
          harness: r.harness,
          caseId: r.caseId,
          ...(r.trigger ? { trigger: r.trigger } : {}),
          ...(r.createdBy ? { createdBy: r.createdBy } : {}),
          createdAt: r.createdAt,
        },
      })),
    ];

    // 활성 예약의 다음 발사(Temporal 이 계산한 nextFireTimes 가 있을 때만 — cron 근사는 웹 표시 영역).
    const upcoming: Array<{ lane: string; entry: QueueUpcoming }> = [];
    for (const s of schedules) {
      if (!s.enabled) continue;
      const at = s.nextFireTimes?.[0];
      if (!at) continue;
      upcoming.push({
        lane: s.runTemplate.runtime ?? "",
        entry: {
          scheduleId: s.id,
          name: s.name,
          at,
          dataset: s.runTemplate.dataset.id,
          harness: s.runTemplate.harness.id,
        },
      });
    }

    // 레인 집합: 기본('') + 등록 런타임(빈 레인도 노출 — "이 런타임은 지금 놀고 있음"이 정보) + 활성 작업/예약이 참조하는 런타임.
    const registered = new Set(runtimes.map((r) => r.id));
    const laneKeys = new Set<string>(["", ...registered]);
    for (const { lane } of items) laneKeys.add(lane);
    for (const { lane } of upcoming) laneKeys.add(lane);

    const byCreatedAsc = (a: QueueItem, b: QueueItem): number => a.createdAt.localeCompare(b.createdAt);
    const lanes: QueueLane[] = [...laneKeys]
      .sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b))) // 기본 백엔드 레인을 맨 위로
      .map((key) => ({
        runtime: key,
        registered: registered.has(key),
        running: items
          .filter((x) => x.lane === key && x.item.status === "running")
          .map((x) => x.item)
          .sort(byCreatedAsc),
        queued: items
          .filter((x) => x.lane === key && x.item.status === "queued")
          .map((x) => x.item)
          .sort(byCreatedAsc), // FIFO — 맨 앞이 다음 작업
        upcoming: upcoming
          .filter((x) => x.lane === key)
          .map((x) => x.entry)
          .sort((a, b) => a.at.localeCompare(b.at))
          .slice(0, this.upcomingPerLane),
      }));

    return {
      generatedAt: this.now(),
      totals: {
        running: items.filter((x) => x.item.status === "running").length,
        queued: items.filter((x) => x.item.status === "queued").length,
        upcoming: upcoming.length,
      },
      lanes,
    };
  }
}
