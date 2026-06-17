import { randomUUID } from "node:crypto";

// per-run 키 — 공유 스토어를 케이스별로 논리격리하는 식별자들.
export interface RunKeys {
  runId: string;
  threadId: string; // LangGraph thread_id (Postgres 체크포인트 격리)
  streamChannel: string; // Redis key-prefix
  minioPrefix: string; // MinIO object-prefix
}

// runId → 파생 키 (순수/결정적).
export function keysFor(runId: string): RunKeys {
  return { runId, threadId: `run-${runId}`, streamChannel: `run-${runId}`, minioPrefix: `runs/${runId}/` };
}

export function newRunId(): string {
  return randomUUID();
}

// (Phase 2 에서 warm 풀/리스 관리로 확장)
export class EnvironmentManager {
  newRun(): RunKeys {
    return keysFor(newRunId());
  }
}
