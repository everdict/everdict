import type { ComputeHandle } from "./compute.js";
import type { TraceEvent } from "./trace.js";

export interface RunContext {
  // 보통 비어있음 — claude CLI 는 머신의 구독 로그인으로 동작. 로그인 없는 샌드박스에서만 키 주입.
  apiKeyEnv: Record<string, string>;
  timeoutSec: number;
}

// 피평가 대상. ComputeHandle(샌드박스) 안에서 구동되며, native 출력을
// 정규화 TraceEvent로 변환해 yield 한다. 프로세스 경계 너머로 구동되므로
// 피평가 하니스는 어떤 언어(TS/Python/CLI)든 무관하다.
export interface EvaluableHarness {
  readonly id: string;
  readonly version: string; // 버전 관리의 단위
  install(compute: ComputeHandle): Promise<void>;
  run(compute: ComputeHandle, task: string, ctx: RunContext): AsyncIterable<TraceEvent>;
}
