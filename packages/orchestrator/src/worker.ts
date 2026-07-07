import { fileURLToPath } from "node:url";
import { collectAuthEnv } from "@everdict/agent";
import { BackendRegistry, type BackendsConfig, LocalBackend, Scheduler, buildRegistry } from "@everdict/backends";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createActivities } from "./activities.js";
import { TASK_QUEUE } from "./constants.js";

export interface WorkerOptions {
  address?: string; // Temporal 주소 (기본 localhost:7233)
  taskQueue?: string;
  config?: BackendsConfig; // 백엔드 선언 (없으면 단일 local)
  maxQueueDepth?: number; // 스케줄러 백프레셔 (기본 무제한)
}

// 컨트롤플레인 워커: 용량 인지 Scheduler(백엔드 레지스트리)를 들고 액티비티+워크플로를 등록해
// task queue 를 폴링한다. 스케줄러가 백엔드 여유를 보고 배치하고, 자리 없으면 큐잉한다.
// 장시간 실행 프로세스. (`everdict worker` 로 띄움)
export async function runWorker(opts: WorkerOptions = {}): Promise<void> {
  const { registry } = opts.config
    ? buildRegistry(opts.config, { secretEnv: collectAuthEnv() })
    : { registry: new BackendRegistry().register("local", new LocalBackend()) };
  const scheduler = new Scheduler(registry, { maxQueueDepth: opts.maxQueueDepth });

  // 예약 발사 액티비티 — 컨트롤플레인 internal 라우트로 브리지(둘 다 설정됐을 때만 활성; scheduledScorecardWorkflow 전용).
  const apiUrl = process.env.EVERDICT_API_URL;
  const internalToken = process.env.EVERDICT_INTERNAL_TOKEN;
  const scheduleApi = apiUrl && internalToken ? { apiUrl, internalToken } : undefined;

  const connection = await NativeConnection.connect({ address: opts.address ?? "localhost:7233" });
  try {
    const worker = await Worker.create({
      connection,
      taskQueue: opts.taskQueue ?? TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("./workflows.js", import.meta.url)),
      activities: createActivities(scheduler, scheduleApi),
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}
