import { randomUUID } from "node:crypto";
import type { TopologyDependency } from "@assay/core";

// per-run 키 — 공유 스토어를 케이스별로 논리격리하는 식별자들.
export interface RunKeys {
  runId: string;
  threadId: string; // LangGraph thread_id (Postgres 체크포인트 격리)
  streamChannel: string; // Redis key-prefix
  minioPrefix: string; // MinIO object-prefix
}

// runId → 파생 키 (순수/결정적). 현행 browser-use 기본 본문(stream_channel/minio_prefix 이름)용.
export function keysFor(runId: string): RunKeys {
  return { runId, threadId: `run-${runId}`, streamChannel: `run-${runId}`, minioPrefix: `runs/${runId}/` };
}

// isolateBy 종류 → (템플릿 변수 이름, per-run 값). LangGraph 고정 이름 대신 isolateBy 분류에서 파생.
// "external"(BYO 외부 스토어)은 케이스별 격리가 없으므로 호출 전에 걸러진다(wiringVars).
function isolationVar(
  isolateBy: Exclude<TopologyDependency["isolateBy"], "external">,
  runId: string,
): [string, string] {
  switch (isolateBy) {
    case "thread_id":
      return ["thread_id", `run-${runId}`];
    case "key-prefix":
      return ["key_prefix", `run-${runId}`];
    case "object-prefix":
      return ["object_prefix", `runs/${runId}/`];
    case "schema":
      return ["schema", `run_${runId}`];
  }
}

// per-run 와이어링 변수 — 선언된 의존 스토어의 isolateBy 에서 파생(+ run_id + 호출자 extra: task/target_cdp_url 등).
// front-door 본문 템플릿({{thread_id}} 등) + poll statusPath({run_id} 등) 보간에 쓰이는 단일 어휘.
export function wiringVars(
  runId: string,
  dependencies: TopologyDependency[],
  extra: Record<string, string> = {},
): Record<string, string> {
  const vars: Record<string, string> = { run_id: runId, ...extra };
  for (const dep of dependencies) {
    if (dep.isolateBy === "external") continue; // 외부 스토어는 케이스별 격리 변수 없음
    const [name, value] = isolationVar(dep.isolateBy, runId);
    vars[name] = value;
  }
  return vars;
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
