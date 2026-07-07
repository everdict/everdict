import { z } from "zod";
import { EnvSnapshotSchema, EnvSpecSchema } from "./environment.js";
import { ScoreSchema } from "./grader.js";
import { TraceEventSchema } from "./trace.js";

// 그레이더 지정: id + 선택적 config (예: tests-pass 의 { cmd }).
// 에이전트가 이 스펙으로부터 Grader 인스턴스를 재구성한다.
export const GraderSpecSchema = z.object({
  id: z.string(),
  config: z.record(z.unknown()).optional(),
});
export type GraderSpec = z.infer<typeof GraderSpecSchema>;

// 배치(placement) 힌트 — 컨트롤플레인 라우터가 어느 백엔드로 보낼지 결정할 때 본다.
// 에이전트는 이 필드를 무시한다(실행 위치는 에이전트의 관심사가 아니다).
export const PlacementSchema = z.object({
  target: z.string().optional(), // 등록된 백엔드 이름 (예: "nomad-seoul")
  os: z.enum(["linux", "windows", "macos"]).optional(),
  isolation: z.string().optional(), // 예: "gvisor"
});
export type Placement = z.infer<typeof PlacementSchema>;

export const EvalCaseSchema = z.object({
  id: z.string(),
  env: EnvSpecSchema,
  task: z.string(),
  graders: z.array(GraderSpecSchema),
  image: z.string().optional(),
  timeoutSec: z.number().default(1800),
  tags: z.array(z.string()).default([]),
  placement: PlacementSchema.optional(),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

// 실행 출처(프로비넌스) — 컨트롤플레인이 스탬프(러너 자기보고 아님). 셀프호스티드 러너처럼 "비관리 호스트"에서
// 돈 결과를 워크스페이스가 식별/신뢰가중하도록. 기본(관리형 백엔드)은 미설정.
export const CaseProvenanceSchema = z.object({
  ranOn: z.string(), // 예: "self-hosted"
  runner: z.string().optional(), // 러너 id(디바이스)
  by: z.string().optional(), // 실행한 주체(principal.subject)
});
export type CaseProvenance = z.infer<typeof CaseProvenanceSchema>;

// 수집이 잡 밖(컨트롤플레인)으로 미뤄진 케이스의 플랫폼 좌표 — spec.trace.collect="control-plane" 일 때
// 에이전트가 실어 보내고, executeCase 가 pull+미뤄진 관측물 채점으로 결과를 완성한다(수집 후에도 provenance 로 유지).
// docs/architecture/streaming-case-pipeline.md D4
export const TraceRefSchema = z.object({
  kind: z.enum(["otel", "mlflow", "langfuse", "langsmith", "phoenix"]), // buildTraceSource 5종과 동일
  endpoint: z.string(),
  runId: z.string(), // 상관 키(assay.run_id) — 이 값으로 플랫폼에서 트레이스를 찾는다
  // 인증 시크릿 '이름'(SecretStore) — 컨트롤플레인이 collect 시 값으로 재해석해 어댑터 관례 헤더로
  // (otel/mlflow=verbatim Authorization, langsmith=x-api-key 등). 값은 절대 싣지 않는다(CaseResult 는 영속된다).
  authSecret: z.string().optional(),
  correlate: z.enum(["id", "tag"]).optional(), // mlflow/otel — tag 면 assay.run_id 태그(리소스 속성) 검색으로 상관
  experiment: z.string().optional(), // mlflow tag 상관의 검색 범위(experiment id)
  project: z.string().optional(), // phoenix 전용 — 스팬 조회 경로의 프로젝트
  service: z.string().optional(), // otel tag 상관의 검색 범위(Jaeger service — 에이전트의 service.name)
});
export type TraceRef = z.infer<typeof TraceRefSchema>;

export const CaseResultSchema = z.object({
  caseId: z.string(),
  harness: z.string(), // "claude-code@1.2.3"
  trace: z.array(TraceEventSchema),
  snapshot: EnvSnapshotSchema,
  scores: z.array(ScoreSchema),
  provenance: CaseProvenanceSchema.optional(), // 셀프호스티드 등 비관리 실행의 출처(컨트롤플레인 스탬프)
  traceRef: TraceRefSchema.optional(), // 컨트롤플레인 수집 대상(위) — job 수집(기본)에는 없음
});
export type CaseResult = z.infer<typeof CaseResultSchema>;

export const ScorecardSchema = z.object({
  suiteId: z.string(),
  harness: z.string(),
  results: z.array(CaseResultSchema),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;
