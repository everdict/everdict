import { Client, Connection } from "@temporalio/client";
import type { ScheduleDriver, ScheduleSpec } from "./schedule-service.js";

// 컨트롤플레인이 예약을 Temporal Schedule 로 동기화한다(DB 가 SSOT, 이 드라이버가 Temporal 을 맞춘다).
// @temporalio/client 만 사용(워커의 네이티브 바인딩 @temporalio/worker 를 API 프로세스로 끌어오지 않음).
// 발사 시 워커의 scheduledScorecardWorkflow(scheduleId, tenant) 를 시작한다. 설계: docs/architecture/scheduled-evals.md.
// TASK_QUEUE 는 워커(@everdict/orchestrator constants.TASK_QUEUE="everdict-eval")와 일치해야 한다.
const TASK_QUEUE = "everdict-eval";

const OVERLAP: Record<ScheduleSpec["overlapPolicy"], "SKIP" | "BUFFER_ONE" | "ALLOW_ALL"> = {
  skip: "SKIP",
  bufferOne: "BUFFER_ONE",
  allowAll: "ALLOW_ALL",
};

const scheduleIdOf = (id: string): string => `everdict-sched-${id}`;

export class TemporalScheduleDriver implements ScheduleDriver {
  private readonly address: string;
  private readonly taskQueue: string;
  constructor(opts: { address?: string; taskQueue?: string } = {}) {
    this.address = opts.address ?? "localhost:7233";
    this.taskQueue = opts.taskQueue ?? TASK_QUEUE;
  }

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const connection = await Connection.connect({ address: this.address });
    try {
      return await fn(new Client({ connection }));
    } finally {
      await connection.close();
    }
  }

  async ensure(spec: ScheduleSpec): Promise<void> {
    await this.withClient(async (client) => {
      const sid = scheduleIdOf(spec.id);
      // 멱등: 있으면 지우고 새로 만든다(업데이트 fn 의 복잡한 타입 회피; eval 스케줄은 run 이력보다 정의가 SSOT).
      const handle = client.schedule.getHandle(sid);
      try {
        await handle.describe();
        await handle.delete();
      } catch {
        // 없음 → 그냥 생성
      }
      await client.schedule.create({
        scheduleId: sid,
        spec: { cronExpressions: [spec.cron], timezone: spec.timezone },
        action: {
          type: "startWorkflow",
          workflowId: `everdict-sched-run-${spec.id}`,
          workflowType: "scheduledScorecardWorkflow",
          taskQueue: this.taskQueue,
          args: [{ scheduleId: spec.id, tenant: spec.tenant }],
        },
        policies: { overlap: OVERLAP[spec.overlapPolicy] },
        state: { paused: spec.paused },
      });
    });
  }

  async remove(id: string): Promise<void> {
    await this.withClient(async (client) => {
      try {
        await client.schedule.getHandle(scheduleIdOf(id)).delete();
      } catch {
        // 이미 없음 — 멱등
      }
    });
  }

  // Temporal 이 계산한 다음 발사 시각(authoritative) — 한 커넥션으로 여러 id 를 describe.
  // 스케줄이 Temporal 에 없으면(아직 미동기화/삭제) 생략 → 서비스가 그대로 반환하고 웹이 cron 근사로 폴백.
  async describeMany(ids: string[]): Promise<Record<string, string[]>> {
    if (ids.length === 0) return {};
    return this.withClient(async (client) => {
      const out: Record<string, string[]> = {};
      for (const id of ids) {
        try {
          const desc = await client.schedule.getHandle(scheduleIdOf(id)).describe();
          out[id] = desc.info.nextActionTimes.map((d) => d.toISOString());
        } catch {
          // 없음 — 생략
        }
      }
      return out;
    });
  }
}
