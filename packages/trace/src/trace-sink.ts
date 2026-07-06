import type { TraceEvent } from "@assay/core";

// 케이스 결과(trace+점수)를 외부 관측 플랫폼(MLflow/Langfuse/LangSmith/Phoenix)으로 내보낸다 —
// TraceSource(인바운드 pull)의 아웃바운드 거울. 스코어카드는 요약+링크만 소개하고 상세는 플랫폼이 진실원천.
// 설계: docs/architecture/trace-sink.md

// 플랫폼의 score/feedback/assessment/annotation 로 매핑될 점수 1건. name = Score.metric.
export interface TraceSinkScore {
  name: string;
  value: number;
  pass?: boolean;
  comment?: string; // Score.detail(문자열일 때) — rationale/설명으로 전달
}

export interface TraceSinkCase {
  caseId: string;
  trace: TraceEvent[];
  scores: TraceSinkScore[];
  // 있으면 attach 모드(흐름② — 기존 trace 에 점수만 부착), 없으면 create 모드(흐름① — trace 생성+부착).
  externalId?: string;
}

// 내보내기 문맥 — 플랫폼 쪽 trace 이름/태그/메타데이터에 실린다.
export interface TraceSinkContext {
  scorecardId: string;
  dataset: string; // "id@version"
  harness: string; // "id@version"
}

export interface TraceSinkCaseResult {
  caseId: string;
  externalId?: string; // 생성했거나 부착한 플랫폼 trace/run id
  url?: string; // 케이스 trace 딥링크
  error?: string; // 케이스별 실패(격리 — 다른 케이스는 계속 적재)
}

export interface TraceSinkResult {
  url?: string; // 상위(experiment/project) 딥링크
  cases: TraceSinkCaseResult[];
}

// 어댑터 계약. 케이스 배열을 한 번에 받아 내부에서 배치/루프를 선택한다(Langfuse 는 배치 ingestion 1콜).
// 전면 실패(인증/연결)는 UpstreamError throw, 케이스별 실패는 cases[].error 로 격리.
export interface TraceSink {
  export(ctx: TraceSinkContext, cases: TraceSinkCase[]): Promise<TraceSinkResult>;
}

// 설정 → TraceSink 팩토리 입력(buildTraceSink). TraceSourceConfig 와 대칭.
// auth = SecretStore 에서 resolve 된 자격증명 '값' — 헤더 이름은 어댑터가 플랫폼 관례대로 소유
// (mlflow/langfuse/phoenix: Authorization 에 그대로, langsmith: x-api-key). 값에 스킴 포함(Basic …/Bearer …).
export interface TraceSinkConfig {
  kind: "mlflow" | "langfuse" | "langsmith" | "phoenix";
  endpoint: string;
  auth?: string;
  project?: string; // kind별 좌표: mlflow experiment_id · langsmith project · phoenix project · langfuse projectId(링크)
  webUrl?: string; // UI 딥링크 베이스(미지정 = endpoint)
  fetchImpl?: typeof fetch; // 테스트 주입
}
