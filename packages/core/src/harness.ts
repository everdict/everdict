import type { ComputeHandle } from "./compute.js";
import type { TraceEvent } from "./trace.js";

export interface RunContext {
  // 보통 비어있음 — claude CLI 는 머신의 구독 로그인으로 동작. 로그인 없는 샌드박스에서만 키 주입.
  apiKeyEnv: Record<string, string>;
  timeoutSec: number;
  // 트레이스 상관 키 — runCase 가 채워 run(하니스가 ASSAY_RUN_ID/assay.run_id 로 주입)과
  // collectTrace(플랫폼 pull) 양쪽에 같은 값이 흐르게 한다. 미지정이면 하니스가 자체 mint(하위호환).
  runId?: string;
}

// 하니스 트레이스가 적재되는 외부 플랫폼 좌표 + 수집 위치.
// collect="job"(기본) = 잡 안에서 compute 해제 후 pull. "control-plane" = 잡은 실행에서 끝나고
// 컨트롤플레인이 CaseResult.traceRef 로 pull(엔드포인트가 컨트롤플레인에서 닿을 때만 —
// 클러스터 내부 엔드포인트는 job 유지). docs/architecture/streaming-case-pipeline.md D4
export interface HarnessTraceSource {
  kind: "otel" | "mlflow";
  endpoint: string;
  collect: "job" | "control-plane";
}

// 피평가 대상. ComputeHandle(샌드박스) 안에서 구동되며, native 출력을
// 정규화 TraceEvent로 변환해 yield 한다. 프로세스 경계 너머로 구동되므로
// 피평가 하니스는 어떤 언어(TS/Python/CLI)든 무관하다.
export interface EvaluableHarness {
  readonly id: string;
  readonly version: string; // 버전 관리의 단위
  install(compute: ComputeHandle): Promise<void>;
  run(compute: ComputeHandle, task: string, ctx: RunContext): AsyncIterable<TraceEvent>;
  // 트레이스가 외부 플랫폼(OTel/MLflow)에 적재되는 하니스만 구현(command otel/mlflow 등).
  // traceSource(): 그 플랫폼 좌표(스펙에서). collectTrace(): 적재된 트레이스를 runId 로 pull —
  // runCase 가 compute 해제 후 호출한다(플러시 지연 동안 샌드박스 미점유). 미구현 = run() 이 트레이스 전부 yield.
  traceSource?(): HarnessTraceSource | undefined;
  collectTrace?(runId: string): Promise<TraceEvent[]>;
}
