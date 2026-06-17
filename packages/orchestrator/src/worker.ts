import { fileURLToPath } from "node:url";
import { collectAuthEnv } from "@assay/agent";
import { BackendRegistry, type BackendsConfig, LocalBackend, Router, buildRegistry } from "@assay/backends";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createActivities } from "./activities.js";
import { TASK_QUEUE } from "./constants.js";

export interface WorkerOptions {
  address?: string; // Temporal 주소 (기본 localhost:7233)
  taskQueue?: string;
  config?: BackendsConfig; // 백엔드 선언 (없으면 단일 local)
}

// 컨트롤플레인 워커: Router(백엔드 레지스트리)를 들고 액티비티+워크플로를 등록해 task queue 를 폴링한다.
// 장시간 실행 프로세스. (`assay worker` 로 띄움)
export async function runWorker(opts: WorkerOptions = {}): Promise<void> {
  const { registry, defaultTarget } = opts.config
    ? buildRegistry(opts.config, { secretEnv: collectAuthEnv() })
    : { registry: new BackendRegistry().register("local", new LocalBackend()), defaultTarget: "local" };
  const router = new Router(registry, defaultTarget);

  const connection = await NativeConnection.connect({ address: opts.address ?? "localhost:7233" });
  try {
    const worker = await Worker.create({
      connection,
      taskQueue: opts.taskQueue ?? TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("./workflows.js", import.meta.url)),
      activities: createActivities(router),
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}
